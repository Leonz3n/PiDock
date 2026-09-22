import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { app, BrowserWindow, nativeImage, WebContentsView } from "electron";
import type { WebPreferences } from "electron";
import { TaskAutomation, type Locator } from "./task-automation.js";
import { TaskBrowser, type TaskTab } from "./task-browser.js";
import { TrustDomainRegistry } from "./trust-domain.js";

export interface TaskBrowserS4Checks {
  visibleSameWebContents: boolean;
  semanticLocator: boolean;
  actionabilityWait: boolean;
  fillAndClick: boolean;
  screenshot: boolean;
  consoleErrorCaptured: boolean;
  failedRequestCaptured: boolean;
  boundedEvidence: boolean;
}

export interface TaskBrowserS4Evidence {
  taskId: string;
  partition: string;
  webContentsId: number;
  browserWindow: { visible: boolean; childCount: number };
  view: { attached: boolean; visible: boolean; automationWebContentsId: number };
  locator: { tag: string; role: string; name: string; disabled: boolean };
  actionabilityWaitMs: number;
  screenshot: {
    path: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
    nonWhitePixels: number;
  };
  bounded: {
    consoleCount: number;
    maxConsoleTextLength: number;
    failedRequestCount: number;
    maxFailedTextLength: number;
  };
  consoleErrors: ReturnType<TaskAutomation["evidence"]>["consoleErrors"];
  failedRequests: ReturnType<TaskAutomation["evidence"]>["failedRequests"];
}

export interface TaskBrowserS4Success {
  schema: "pidock.shell.s4-smoke.v1";
  ok: true;
  electron: string;
  checks: TaskBrowserS4Checks;
  evidence: TaskBrowserS4Evidence;
}

export interface TaskBrowserS4Failure {
  schema: "pidock.shell.s4-smoke.v1";
  ok: false;
  error: { stage: string; message: string };
  evidence: Partial<TaskBrowserS4Evidence>;
}

export type TaskBrowserS4Report =
  | TaskBrowserS4Success
  | TaskBrowserS4Failure;

interface FixtureServer {
  origin: string;
  server: Server;
}

const SAFE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} satisfies WebPreferences;

const FIXTURE_SCRIPT = String.raw`
(function () {
  var input = document.querySelector('[data-testid="name"]');
  var button = document.querySelector('[data-testid="save"]');
  var status = document.querySelector('[data-testid="status"]');
  button.disabled = true;
  window.__pidockS4EnableSoon = function () {
    setTimeout(function () { button.disabled = false; }, 700);
  };
  window.__pidockS4Emit = function () {
    for (var index = 0; index < 12; index += 1) {
      console.error("S4 expected console error " + index + " " + "x".repeat(220));
    }
    fetch("http://127.0.0.1:1/pidock-s4-missing").catch(function () {});
  };
  input.addEventListener("input", function () {
    document.body.dataset.name = input.value;
    status.textContent = "typing:" + input.value;
  });
  button.addEventListener("click", function () {
    document.body.dataset.result = "saved";
    status.textContent = "saved:" + input.value;
  });
})();
`;

function fixtureHtml(): string {
  return [
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">",
    "<title>PiDock S4 Fixture</title>",
    "<style>body{font:16px system-ui;padding:32px}button:disabled{opacity:.4}</style>",
    "</head><body>",
    "<label for=\"name\">名称</label>",
    "<input id=\"name\" data-testid=\"name\" aria-label=\"名称\">",
    "<button data-testid=\"save\" aria-label=\"保存\">保存</button>",
    "<output data-testid=\"status\"></output>",
    `<script>${FIXTURE_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    await sleep(50);
  }
  throw new Error(`${label} timed out`);
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(fixtureHtml());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("S4 fixture server did not expose an IP address");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function stopFixtureServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assertBounded(values: readonly { text?: string; url?: string; errorText?: string }[]): boolean {
  return values.length <= 20 && values.every((value) =>
    [value.text, value.url, value.errorText].every(
      (text) => text === undefined || text.length <= 240,
    ),
  );
}

export async function runTaskBrowserS4Smoke(): Promise<TaskBrowserS4Report> {
  const evidence: Partial<TaskBrowserS4Evidence> = {};
  let stage = "fixture-server";
  let fixture: FixtureServer | undefined;
  let window: BrowserWindow | undefined;
  let taskBrowser: TaskBrowser | undefined;
  let tab: TaskTab | undefined;
  let automation: TaskAutomation | undefined;

  try {
    fixture = await startFixtureServer();

    stage = "visible-view";
    window = new BrowserWindow({
      width: 1100,
      height: 760,
      show: true,
      webPreferences: SAFE_WEB_PREFERENCES,
    });
    const shellView = new WebContentsView({ webPreferences: SAFE_WEB_PREFERENCES });
    const registry = new TrustDomainRegistry();
    registry.registerShell({
      webContentsId: shellView.webContents.id,
      viewId: "s4-shell-view",
      workspaceId: "s4-workspace",
    });
    window.contentView.addChildView(shellView);
    shellView.setBounds({ x: 0, y: 0, width: 260, height: 760 });
    await shellView.webContents.loadURL(
      "data:text/html,<title>PiDock S4 Shell</title><h1>PiDock S4</h1>",
    );

    taskBrowser = new TaskBrowser({
      window,
      workspaceId: "s4-workspace",
      taskId: "s4-task",
      bounds: { x: 260, y: 0, width: 840, height: 760 },
      registry,
    });
    tab = await taskBrowser.openTab(`${fixture.origin}/`, "s4-page");

    stage = "cdp-attach";
    automation = await TaskAutomation.attach(tab, { maxEvents: 8, maxTextLength: 120 });
    await automation.run("window.__pidockS4EnableSoon && window.__pidockS4EnableSoon()");
    await automation.run("window.__pidockS4Emit && window.__pidockS4Emit()");

    const visibleSameWebContents =
      window.isVisible() === true &&
      tab.view.getVisible() === true &&
      window.contentView.children.includes(tab.view) &&
      automation.webContentsId === tab.webContentsId;

    stage = "locator-actionability";
    const buttonLocator: Locator = { kind: "testId", value: "save" };
    const waitStartedAt = Date.now();
    const actionable = await automation.waitForActionable(buttonLocator);
    const actionabilityWaitMs = Date.now() - waitStartedAt;
    const roleLocator: Locator = { kind: "role", role: "button", name: "保存" };
    const roleMatch = await automation.locate(roleLocator);
    const semanticLocator =
      actionable.tag === "button" &&
      actionable.disabled === false &&
      roleMatch?.name === "保存";

    stage = "fill-click";
    await automation.fill({ kind: "label", value: "名称" }, "PiDock");
    await automation.click(buttonLocator);
    await automation.waitForExpression(
      'document.body.dataset.result === "saved" && document.body.dataset.name === "PiDock"',
      "fill and click result",
    );
    const textMatch = await automation.locate({
      kind: "text",
      value: "saved:PiDock",
    });
    const fillAndClick = textMatch?.tag === "output";

    stage = "screenshot";
    const screenshot = await automation.screenshot();
    const screenshotPath = path.join(
      app.getPath("temp"),
      `pidock-s4-screenshot-${process.pid}-${Date.now()}.png`,
    );
    writeFileSync(screenshotPath, screenshot.buffer);
    const bitmap = nativeImage.createFromBuffer(screenshot.buffer).toBitmap();
    let nonWhitePixels = 0;
    for (let index = 0; index + 3 < bitmap.length; index += 4) {
      if (
        bitmap[index + 3] !== 0 &&
        (bitmap[index] < 250 || bitmap[index + 1] < 250 || bitmap[index + 2] < 250)
      ) {
        nonWhitePixels += 1;
      }
    }

    stage = "console-network";
    const automationEvidence = await waitFor(
      "console and failed request evidence",
      () => {
        const current = automation!.evidence();
        return current.consoleErrors.length === 8 && current.failedRequests.length > 0
          ? current
          : undefined;
      },
    );
    const maxConsoleTextLength = Math.max(
      0,
      ...automationEvidence.consoleErrors.map((item) => item.text.length),
    );
    const maxFailedTextLength = Math.max(
      0,
      ...automationEvidence.failedRequests.map(
        (item) => item.url.length + item.errorText.length,
      ),
    );
    const boundedEvidence =
      automationEvidence.consoleErrors.length === 8 &&
      maxConsoleTextLength <= 120 &&
      assertBounded(automationEvidence.consoleErrors) &&
      assertBounded(automationEvidence.failedRequests);

    const checks: TaskBrowserS4Checks = {
      visibleSameWebContents,
      semanticLocator,
      actionabilityWait: actionabilityWaitMs >= 300,
      fillAndClick,
      screenshot:
        screenshot.bytes > 1000 &&
        screenshot.width > 0 &&
        screenshot.height > 0 &&
        screenshot.sha256.length === 64 &&
        nonWhitePixels > 100,
      consoleErrorCaptured: automationEvidence.consoleErrors.some((item) =>
        item.text.includes("S4 expected console error"),
      ),
      failedRequestCaptured: automationEvidence.failedRequests.some(
        (item) =>
          item.url.includes("/pidock-s4-missing") &&
          item.errorText.length > 0,
      ),
      boundedEvidence,
    };
    assert(
      Object.values(checks).every(Boolean),
      `S4 checks failed: ${JSON.stringify(checks)}`,
    );

    return {
      schema: "pidock.shell.s4-smoke.v1",
      ok: true,
      electron: process.versions["electron"] ?? "unknown",
      checks,
      evidence: {
        taskId: taskBrowser.taskId,
        partition: taskBrowser.partition,
        webContentsId: tab.webContentsId,
        browserWindow: {
          visible: window.isVisible(),
          childCount: window.contentView.children.length,
        },
        view: {
          attached: window.contentView.children.includes(tab.view),
          visible: tab.view.getVisible(),
          automationWebContentsId: automation.webContentsId,
        },
        locator: {
          tag: actionable.tag,
          role: actionable.role,
          name: actionable.name,
          disabled: actionable.disabled,
        },
        actionabilityWaitMs,
        screenshot: {
          path: screenshotPath,
          bytes: screenshot.bytes,
          width: screenshot.width,
          height: screenshot.height,
          sha256: screenshot.sha256,
          nonWhitePixels,
        },
        bounded: {
          consoleCount: automationEvidence.consoleErrors.length,
          maxConsoleTextLength,
          failedRequestCount: automationEvidence.failedRequests.length,
          maxFailedTextLength,
        },
        consoleErrors: automationEvidence.consoleErrors,
        failedRequests: automationEvidence.failedRequests,
      },
    };
  } catch (error) {
    if (automation) {
      const current = automation.evidence();
      evidence.consoleErrors = current.consoleErrors;
      evidence.failedRequests = current.failedRequests;
    }
    return {
      schema: "pidock.shell.s4-smoke.v1",
      ok: false,
      error: { stage, message: errorMessage(error) },
      evidence,
    };
  } finally {
    automation?.dispose();
    taskBrowser?.close();
    window?.destroy();
    await stopFixtureServer(fixture?.server).catch(() => undefined);
  }
}
