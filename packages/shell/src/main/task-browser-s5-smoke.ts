import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { app, BrowserWindow, nativeImage, WebContentsView } from "electron";
import type { WebPreferences } from "electron";
import { AgentPageController, type LayoutEntry } from "./agent-control.js";
import { TaskAutomation } from "./task-automation.js";
import { TaskBrowser, type TaskTab } from "./task-browser.js";
import { TrustDomainRegistry } from "./trust-domain.js";

export interface S5Checks {
  navigateReloadClose: boolean;
  layoutAndScreenshot: boolean;
  knownDesignDeviation: boolean;
  consoleAndNetworkErrors: boolean;
  pointSelectIdentity: boolean;
  boxSelectIdentity: boolean;
  markerInvalidatedOnRefresh: boolean;
  markerRelocatedAfterRefresh: boolean;
  debuggerDevToolsObservationRecorded: boolean;
  debuggerRebind: boolean;
  debuggerDetachOnClose: boolean;
  humanTakeoverBlocksAutomation: boolean;
  humanTakeoverResumeReReads: boolean;
  matrixPopup: boolean;
  matrixIframe: boolean;
  matrixDownload: boolean;
  matrixDevToolsRecovery: boolean;
}

export interface S5MatrixRow {
  name: string;
  handled: boolean;
  note: string;
}

export interface S5Evidence {
  taskId: string;
  webContentsId: number;
  identity: { workspaceId: string; taskId: string; pageId: string; webContentsId: number };
  navigation: { order: string[]; finalUrl: string };
  layout: {
    viewport: { width: number; height: number };
    deviationPx: number;
    expectedDeviationPx: number;
  };
  screenshot: {
    path: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
    nonWhitePixelsInDeviationRegion: number;
  };
  selection: {
    point: { tag: string; role: string; name: string; pageId: string };
    box: { count: number; names: string[]; pageId: string };
  };
  markers: {
    id: string;
    staleAfterRefresh: boolean;
    resolvedAfterRevalidate: boolean;
    elementName: string;
  };
  debugger: {
    attachedBeforeDevTools: boolean;
    attachedDuringDevTools: boolean;
    devToolsDetachedDebugger: boolean;
    detachEventsAfterDevTools: string[];
    rebindSucceeded: boolean;
    detachReasonOnClose: string[];
  };
  consoleErrors: { kind: string; text: string }[];
  failedRequests: { url: string; errorText: string }[];
  takeover: { blockedNavigate: boolean; resumeEpoch: number; resumedStaleMarkerIds: string[] };
  matrix: S5MatrixRow[];
}

export interface S5Success {
  schema: "pidock.shell.s5-smoke.v1";
  ok: true;
  electron: string;
  checks: S5Checks;
  evidence: S5Evidence;
}

export interface S5Failure {
  schema: "pidock.shell.s5-smoke.v1";
  ok: false;
  error: { stage: string; message: string };
  evidence: Partial<S5Evidence>;
}

export type S5Report = S5Success | S5Failure;

const SAFE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} satisfies WebPreferences;

const EXPECTED_DEVIATION_PX = 14;

function designPage(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">',
    "<title>PiDock S5 Design</title>",
    "<style>",
    "body{margin:0;font:16px system-ui}",
    "#card{position:absolute;left:40px;top:120px;width:220px;height:140px;background:#e8eefc}",
    "#badge{position:absolute;left:26px;top:132px;width:90px;height:32px;background:#f97316}",
    "button{margin:20px}",
    "</style></head><body>",
    '<div id="card" data-testid="card"><h2>卡片</h2></div>',
    '<div id="badge" data-testid="badge">NEW</div>',
    '<button data-testid="emit">触发错误</button>',
    '<iframe id="frame" src="/frame" width="300" height="120" title="inner"></iframe>',
    "<script>",
    "window.__s5Emit = function () {",
    '  console.error("S5 known console error: deliberate");',
    '  fetch("/missing-s5").catch(function () {});',
    "};",
    "</script>",
    "</body></html>",
  ].join("");
}

function secondPage(): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>PiDock S5 Second</title></head><body><h1 id="second">第二页</h1></body></html>';
}

async function startFixtureServer(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/download")) {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=pidock-s5.txt",
      });
      response.end("pidock s5 download");
      return;
    }
    if (url.startsWith("/second")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(secondPage());
      return;
    }
    if (url.startsWith("/frame")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><body><p id="inner">iframe body</p></body>');
      return;
    }
    if (url.startsWith("/missing-s5")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(designPage());
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
    throw new Error("S5 fixture server did not expose an IP address");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | null | false,
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

function countDeviationPixels(
  bitmap: Buffer,
  imageWidth: number,
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): number {
  const left = Math.max(0, Math.floor(rect.x * scale));
  const top = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.floor((rect.x + rect.width) * scale);
  const bottom = Math.floor((rect.y + rect.height) * scale);
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * imageWidth + x) * 4;
      if (index + 3 >= bitmap.length) continue;
      if (
        bitmap[index] < 250 ||
        bitmap[index + 1] < 250 ||
        bitmap[index + 2] < 250
      ) {
        count += 1;
      }
    }
  }
  return count;
}

export async function runTaskBrowserS5Smoke(): Promise<S5Report> {
  const evidence: Partial<S5Evidence> = {};
  let stage = "fixture-server";
  let fixture: { origin: string; server: Server } | undefined;
  let window: BrowserWindow | undefined;
  let browser: TaskBrowser | undefined;
  let tab: TaskTab | undefined;
  let automation: TaskAutomation | undefined;
  let controller: AgentPageController | undefined;
  let devToolsOpened = false;

  try {
    fixture = await startFixtureServer();

    stage = "open";
    window = new BrowserWindow({
      width: 1200,
      height: 820,
      show: true,
      webPreferences: SAFE_WEB_PREFERENCES,
    });
    const shellView = new WebContentsView({ webPreferences: SAFE_WEB_PREFERENCES });
    const registry = new TrustDomainRegistry();
    registry.registerShell({
      webContentsId: shellView.webContents.id,
      viewId: "s5-shell-view",
      workspaceId: "s5-workspace",
    });
    window.contentView.addChildView(shellView);
    shellView.setBounds({ x: 0, y: 0, width: 220, height: 820 });
    await shellView.webContents.loadURL(
      "data:text/html,<title>PiDock S5 Shell</title><h1>PiDock S5</h1>",
    );

    browser = new TaskBrowser({
      window,
      workspaceId: "s5-workspace",
      taskId: "s5-task",
      bounds: { x: 220, y: 0, width: 980, height: 820 },
      registry,
    });
    tab = await browser.openTab(`${fixture.origin}/`, "s5-page");

    stage = "automation";
    automation = await TaskAutomation.attach(tab, { maxEvents: 12, maxTextLength: 160 });
    controller = new AgentPageController(tab, automation, "s5-workspace");

    // --- Acceptance 8: markers, layout, deviation, selection, refresh ---
    stage = "markers";
    const marker = await controller.mark("save-button", {
      kind: "testId",
      value: "card",
    });
    assert(marker.element !== null, "marker did not resolve on first load");

    stage = "layout";
    const layoutEntries: LayoutEntry[] = [
      { name: "card", locator: { kind: "testId", value: "card" } },
      { name: "badge", locator: { kind: "testId", value: "badge" } },
    ];
    const layout = await controller.readLayout(layoutEntries);
    const cardEntry = layout.elements.find((entry) => entry.name === "card");
    const badgeEntry = layout.elements.find((entry) => entry.name === "badge");
    const cardDetails = cardEntry?.details;
    const badgeDetails = badgeEntry?.details;
    assert(cardDetails && badgeDetails, "layout did not resolve card/badge");
    const deviationPx = cardDetails.rect.x - badgeDetails.rect.x;

    stage = "screenshot";
    const screenshot = await automation.screenshot();
    const screenshotPath = path.join(
      app.getPath("temp"),
      `pidock-s5-screenshot-${process.pid}-${Date.now()}.png`,
    );
    writeFileSync(screenshotPath, screenshot.buffer);
    const bitmap = nativeImage.createFromBuffer(screenshot.buffer).toBitmap();
    const scale = layout.viewport.width > 0 ? screenshot.width / layout.viewport.width : 1;
    const nonWhitePixelsInDeviationRegion = countDeviationPixels(
      bitmap,
      screenshot.width,
      badgeDetails.rect,
      scale,
    );

    // --- Acceptance 8: known console + network errors ---
    stage = "errors";
    await automation.run("window.__s5Emit && window.__s5Emit()");
    const captured = await waitFor(
      "console and network errors",
      () => {
        const current = automation!.evidence();
        return current.consoleErrors.length > 0 && current.failedRequests.length > 0
          ? current
          : undefined;
      },
    );

    // --- Acceptance 8: point / box selection ---
    stage = "selection";
    const point = await controller.pointSelect(
      badgeDetails.center.x,
      badgeDetails.center.y,
    );
    const box = await controller.boxSelect({
      x: badgeDetails.rect.x - 2,
      y: badgeDetails.rect.y - 2,
      width: badgeDetails.rect.width + 4,
      height: badgeDetails.rect.height + 4,
    });

    // --- Acceptance 8: refresh invalidates then re-locates the marker ---
    stage = "refresh";
    await controller.reload();
    const staleAfterRefresh =
      controller.session.markers.find((item) => item.id === marker.id)?.stale === true;
    const revalidation = await controller.revalidateMarkers();
    const relocated = revalidation.resolved.find((item) => item.id === marker.id);

    // --- Acceptance 8: navigate / back / forward / close ---
    stage = "navigate";
    const order: string[] = [];
    await controller.navigate(`${fixture.origin}/second`);
    order.push(new URL(tab.view.webContents.getURL()).pathname);
    await controller.goBack();
    order.push(new URL(tab.view.webContents.getURL()).pathname);
    await controller.goForward();
    order.push(new URL(tab.view.webContents.getURL()).pathname);

    // --- Acceptance 9: debugger detach on DevTools ---
    stage = "debugger-devtools";
    const attachedBeforeDevTools = automation.isDebuggerAttached();
    tab.view.webContents.openDevTools({ mode: "detach" });
    devToolsOpened = true;
    await sleep(900);
    const attachedDuringDevTools = automation.isDebuggerAttached();
    const detachEventsAfterDevTools = [...automation.detachEvents];
    tab.view.webContents.closeDevTools();
    devToolsOpened = false;
    await sleep(300);
    let rebindSucceeded = false;
    if (!automation.isDebuggerAttached()) await automation.reattach();
    rebindSucceeded = (await automation.run("1 + 1")) === 2;

    // --- Acceptance 9: debugger detach when the WebContents closes ---
    stage = "debugger-close";
    const probeView = new WebContentsView({ webPreferences: SAFE_WEB_PREFERENCES });
    window.contentView.addChildView(probeView);
    await probeView.webContents.loadURL("data:text/html,<title>probe</title>ok");
    const detachReasonOnClose: string[] = [];
    probeView.webContents.debugger.on("detach", (_event, reason) => {
      detachReasonOnClose.push(String(reason));
    });
    probeView.webContents.debugger.attach("1.3");
    probeView.webContents.close();
    await sleep(500);

    // --- Acceptance 10: human takeover pause / resume ---
    stage = "takeover";
    controller.pause("human typing");
    let blockedNavigate = false;
    try {
      await controller.navigate(`${fixture.origin}/second`);
    } catch {
      blockedNavigate = true;
    }
    const resume = await controller.resume(layoutEntries);

    // --- Acceptance 10: popup / iframe / download / devtools matrix ---
    stage = "matrix";
    await controller.navigate(`${fixture.origin}/`);
    const matrix: S5MatrixRow[] = [];

    const popupBefore = browser.popups.length;
    await automation.run(
      "(function(){window.open('/second','_blank');return true;})()",
    );
    const popupHandled = await waitFor("popup created", () =>
      browser!.popups.length > popupBefore ? browser!.popups.length : undefined,
    ).then(() => true).catch(() => false);
    for (const popup of [...browser.popups]) {
      if (!popup.window.isDestroyed()) popup.window.destroy();
    }
    matrix.push({
      name: "popup",
      handled: popupHandled,
      note: "window.open 创建的任务弹窗被 TaskBrowser 注册（复用任务分区）",
    });

    const iframeCount = (await automation.run(
      "document.querySelectorAll('iframe').length",
    )) as number;
    matrix.push({
      name: "iframe",
      handled: typeof iframeCount === "number" && iframeCount >= 1,
      note: "页面内 iframe 存在且主框架自动化在 iframe 存在时仍可工作",
    });

    const downloadHandled = await new Promise<boolean>((resolve) => {
      const handler = (): void => resolve(true);
      browser!.session.once("will-download", (_event, item) => {
        item.cancel();
        handler();
      });
      void automation!.run(
        "(function(){var a=document.createElement('a');a.href='/download';a.download='pidock-s5.txt';document.body.appendChild(a);a.click();return true;})()",
      );
      setTimeout(() => resolve(false), 4000);
    });
    matrix.push({
      name: "download",
      handled: downloadHandled,
      note: "session will-download 触发并可取消，未阻断后续自动化",
    });

    const devtoolsRecovery = (await automation.run("2 + 2")) === 4;
    matrix.push({
      name: "devtools-toggle",
      handled: devtoolsRecovery,
      note: "DevTools 开关后通过 reattach 恢复并继续执行",
    });

    stage = "close";
    const closed = browser.closeTab("s5-page");
    const taskClosed = browser.tabs.length === 0;

    const checks: S5Checks = {
      navigateReloadClose:
        order[0] === "/second" &&
        order[1] === "/" &&
        order[2] === "/second" &&
        closed &&
        taskClosed,
      layoutAndScreenshot:
        layout.viewport.width > 0 &&
        cardEntry?.found === true &&
        screenshot.bytes > 1000 &&
        screenshot.sha256.length === 64,
      knownDesignDeviation:
        Math.abs(deviationPx - EXPECTED_DEVIATION_PX) < 0.5 &&
        nonWhitePixelsInDeviationRegion > 100,
      consoleAndNetworkErrors:
        captured.consoleErrors.some((item) =>
          item.text.includes("S5 known console error"),
        ) && captured.failedRequests.length > 0,
      pointSelectIdentity:
        point.identity.pageId === "s5-page" &&
        point.identity.webContentsId === tab.webContentsId &&
        point.elements.length === 1 &&
        point.elements[0]?.tag === "div",
      boxSelectIdentity:
        box.identity.pageId === "s5-page" &&
        box.elements.length >= 2 &&
        box.elements.some((item) => item.name === "new"),
      markerInvalidatedOnRefresh: staleAfterRefresh,
      markerRelocatedAfterRefresh:
        relocated !== undefined && relocated.element.name.length > 0,
      debuggerDevToolsObservationRecorded:
        attachedBeforeDevTools &&
        (attachedDuringDevTools || detachEventsAfterDevTools.length > 0),
      debuggerRebind: rebindSucceeded,
      debuggerDetachOnClose: detachReasonOnClose.length > 0,
      humanTakeoverBlocksAutomation: blockedNavigate && controller.paused === false,
      humanTakeoverResumeReReads:
        resume.layout.viewport.width > 0 &&
        resume.identity.pageId === "s5-page" &&
        typeof resume.epoch === "number",
      matrixPopup: popupHandled,
      matrixIframe: typeof iframeCount === "number" && iframeCount >= 1,
      matrixDownload: downloadHandled,
      matrixDevToolsRecovery: devtoolsRecovery,
    };
    assert(
      Object.values(checks).every(Boolean),
      `S5 checks failed: ${JSON.stringify(checks)}`,
    );

    return {
      schema: "pidock.shell.s5-smoke.v1",
      ok: true,
      electron: process.versions["electron"] ?? "unknown",
      checks,
      evidence: {
        taskId: browser.taskId,
        webContentsId: tab.webContentsId,
        identity: {
          workspaceId: "s5-workspace",
          taskId: "s5-task",
          pageId: "s5-page",
          webContentsId: tab.webContentsId,
        },
        navigation: {
          order,
          finalUrl: tab.view.webContents.getURL(),
        },
        layout: {
          viewport: {
            width: layout.viewport.width,
            height: layout.viewport.height,
          },
          deviationPx,
          expectedDeviationPx: EXPECTED_DEVIATION_PX,
        },
        screenshot: {
          path: screenshotPath,
          bytes: screenshot.bytes,
          width: screenshot.width,
          height: screenshot.height,
          sha256: screenshot.sha256,
          nonWhitePixelsInDeviationRegion,
        },
        selection: {
          point: {
            tag: point.elements[0]?.tag ?? "",
            role: point.elements[0]?.role ?? "",
            name: point.elements[0]?.name ?? "",
            pageId: point.identity.pageId,
          },
          box: {
            count: box.elements.length,
            names: box.elements.map((item) => item.name),
            pageId: box.identity.pageId,
          },
        },
        markers: {
          id: marker.id,
          staleAfterRefresh,
          resolvedAfterRevalidate: relocated !== undefined,
          elementName: relocated?.element.name ?? "",
        },
        debugger: {
          attachedBeforeDevTools,
          attachedDuringDevTools,
          devToolsDetachedDebugger: !attachedDuringDevTools,
          detachEventsAfterDevTools,
          rebindSucceeded,
          detachReasonOnClose,
        },
        consoleErrors: captured.consoleErrors.map((item) => ({
          kind: item.kind,
          text: item.text,
        })),
        failedRequests: captured.failedRequests.map((item) => ({
          url: item.url,
          errorText: item.errorText,
        })),
        takeover: {
          blockedNavigate,
          resumeEpoch: resume.epoch,
          resumedStaleMarkerIds: [...resume.staleMarkerIds],
        },
        matrix,
      },
    };
  } catch (error) {
    if (automation) {
      const current = automation.evidence();
      evidence.consoleErrors = current.consoleErrors.map((item) => ({
        kind: item.kind,
        text: item.text,
      }));
      evidence.failedRequests = current.failedRequests.map((item) => ({
        url: item.url,
        errorText: item.errorText,
      }));
    }
    return {
      schema: "pidock.shell.s5-smoke.v1",
      ok: false,
      error: {
        stage,
        message: error instanceof Error ? error.message : String(error),
      },
      evidence,
    };
  } finally {
    if (devToolsOpened && tab && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.closeDevTools();
    }
    controller?.dispose();
    automation?.dispose();
    browser?.close();
    window?.destroy();
    await stopServer(fixture?.server).catch(() => undefined);
  }
}
