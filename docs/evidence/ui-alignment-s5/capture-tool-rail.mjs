// [UI 对齐 04] (#28) tool rail evidence: tab strip, single-panel content, service
// row readability across the prototype's width tiers.
//
// Measures the real DOM in headless Chromium (jsdom has no layout) and writes the
// numbers the acceptance items are checked against. Run with the renderer dev
// server on 4335 and the prototype server on 4319:
//
//   node docs/evidence/ui-alignment-s5/capture-tool-rail.mjs
//
// Images and JSON are written next to this file so the evidence stays
// reproducible from the repository (same convention as `ui-alignment-s1`/`-s2`).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/adber/workspace/github/PiDock/packages/renderer/node_modules/playwright-core/index.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  "/Users/adber/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const RENDERER = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const TASK_URL = `${RENDERER}/projects/atlas/tasks/release?session=main`;
const PROTOTYPE_URL = process.env.PROTOTYPE_BASE ?? "http://127.0.0.1:4319";
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
];

const measure = (page) =>
  page.evaluate(() => {
    const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
    const width = (element) => (element ? Math.round(element.getBoundingClientRect().width) : null);
    const rail = document.querySelector('[data-testid="task-rail"]');
    const workbench = document.querySelector('[data-testid="task-workbench"]');
    const tabs = [...document.querySelectorAll('[data-testid^="tool-tab-"][role="tab"]')];
    // A row's endpoint must be readable at every tier (#27 review P2-A): its box
    // has width and its text is not clipped. The instance address may truncate,
    // but then the full identity has to be reachable through the row's `title`.
    const rows = [...document.querySelectorAll('[data-testid^="service-row-"]')].map((button) => {
      const item = button.closest("li");
      const endpoint = item?.querySelector('[data-testid^="service-endpoint-"]') ?? null;
      const instance = item?.querySelector('[data-testid^="service-instance-"]') ?? null;
      const rect = (element) => {
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return { w: Math.round(bounds.width), h: Math.round(bounds.height) };
      };
      return {
        name: button.querySelector("span")?.textContent ?? null,
        text: (item?.innerText ?? "").replace(/\s+/g, " ").trim(),
        title: item?.getAttribute("title") ?? null,
        endpoint: endpoint?.textContent ?? null,
        endpointBox: rect(endpoint),
        // Not clipped by its own box and not clipped by the panel: the endpoint
        // has to be readable inside the 290-310px rail of the narrow tiers.
        endpointFullyVisible: (() => {
          if (!endpoint || !item) return false;
          const end = endpoint.getBoundingClientRect();
          const row = item.getBoundingClientRect();
          return (
            end.width > 0 &&
            endpoint.scrollWidth <= endpoint.clientWidth + 1 &&
            end.left >= row.left - 0.5 &&
            end.right <= row.right + 0.5
          );
        })(),
        instance: instance?.textContent ?? null,
        instanceClipped: instance ? instance.scrollWidth > instance.clientWidth + 1 : null,
        rowH: box(item),
      };
    });
    return {
      viewport: { w: innerWidth, h: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      railPresent: rail !== null,
      railW: width(rail),
      workbenchW: width(workbench),
      tabStripH: box(document.querySelector('[data-testid="tool-tabs-row"]')),
      // The inner `tablist` is the scrollable strip itself; it is shorter than the
      // 44px row because the row owns the border and the vertical padding. The
      // prototype comparison uses `tabStripH` (`.work-tabs` is the row).
      tabListH: box(document.querySelector('[data-testid="tool-tabs"]')),
      tabCount: tabs.length,
      tabs: tabs.map((tab) => ({
        label: tab.textContent?.trim() ?? "",
        selected: tab.getAttribute("aria-selected") === "true",
        tabIndex: tab.getAttribute("tabindex"),
      })),
      activeTab: tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent?.trim() ?? null,
      contentRendered: [...document.querySelectorAll('[data-testid="tool-content"] [data-testid]')].map((node) => node.getAttribute("data-testid")).slice(0, 6),
      closeButtons: [...document.querySelectorAll('[data-testid^="tool-tab-close-"]')].map((button) => button.getAttribute("aria-label")),
      collapseButton: document.querySelector('[data-testid="collapse-tools"]')?.getAttribute("aria-label") ?? null,
      // ARIA tabs pattern: the collapse control must sit beside the strip, not
      // inside `role="tablist"` (#28 review P2-4).
      collapseInsideTablist: (() => {
        const collapse = document.querySelector('[data-testid="collapse-tools"]');
        return collapse !== null && collapse.closest('[role="tablist"]') !== null;
      })(),
      conversationW: width(document.querySelector('[data-testid="task-workspace"]')),
      serviceGroups: {
        local: document.querySelectorAll('[data-testid="service-list-local"] [data-testid^="service-item-"]').length,
        remote: document.querySelectorAll('[data-testid="service-list-remote"] [data-testid^="service-item-"]').length,
        routeBox: document.querySelector('[data-testid="service-route-box"]')?.innerText.replace(/\s+/g, " ").trim() ?? null,
      },
      rows,
    };
  });

async function openPanels(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0) {
      await button.first().click();
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { taskUrl: TASK_URL, states: {}, prototypeA: null };
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(TASK_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  // 1. Three tools open: only the last one's content is rendered.
  await openPanels(page, ["运行", "浏览器", "文件"]);
  report.states[`${viewport.name}-tabs`] = await measure(page);
  await page.screenshot({ path: `${OUT}/renderer/${viewport.width}-tabs.png` });

  // 2. The runtime panel alone: the service rows the P2-A check reads.
  await page.getByTestId("tool-tab-close-browser").click();
  await page.getByTestId("tool-tab-close-files").click();
  await page.waitForTimeout(250);
  report.states[`${viewport.name}-runtime`] = await measure(page);
  await page.screenshot({ path: `${OUT}/renderer/${viewport.width}-runtime.png` });

  // 3. The browser panel alone: the prototype's owner row and snapshot.
  await openPanels(page, ["浏览器"]);
  await page.getByTestId("tool-tab-close-runtime").click();
  await page.waitForTimeout(250);
  report.states[`${viewport.name}-browser`] = {
    ...(await measure(page)),
    browser: await page.evaluate(() => ({
      ownerText: document.querySelector('[data-testid="browser-owner"]')?.innerText.replace(/\s+/g, " ").trim() ?? null,
      handover: document.querySelector('[data-testid="browser-owner"] button')?.textContent?.trim() ?? null,
      snapshot: document.querySelector('[data-testid="browser-snapshot"]')?.innerText.replace(/\s+/g, " ").trim() ?? null,
      validationHeading: [...document.querySelectorAll('[data-testid="tool-content"] h3')].map((node) => node.textContent),
    })),
  };
  await page.screenshot({ path: `${OUT}/renderer/${viewport.width}-browser.png` });

  // 4. Collapsed: the rail is gone and the conversation owns the width again.
  await page.getByTestId("collapse-tools").click();
  await page.waitForTimeout(300);
  report.states[`${viewport.name}-closed`] = await measure(page);
  await page.screenshot({ path: `${OUT}/renderer/${viewport.width}-closed.png` });

  await context.close();
}

// Prototype A at the same viewport: the reference for the tab strip, the work
// content and the service row (`.work-tabs`, `.work-content`, `.service-row`).
const prototypeContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const prototypePage = await prototypeContext.newPage();
await prototypePage.goto(`${PROTOTYPE_URL}/?variant=A`, { waitUntil: "networkidle" });
await prototypePage.waitForTimeout(500);
// The prototype keeps its tool rail behind `openTools`; open every launcher.
for (const label of ["打开运行", "打开浏览器", "打开文件", "打开终端", "打开日志"]) {
  const button = prototypePage.getByRole("button", { name: label });
  if ((await button.count()) > 0) {
    await button.first().click();
    await prototypePage.waitForTimeout(100);
  }
}
await prototypePage.waitForTimeout(300);
// The run panel first (service rows), then the browser panel (owner + snapshot).
const prototypeTabs = prototypePage.locator(".work-tab");
await prototypeTabs.first().click();
await prototypePage.waitForTimeout(250);
report.prototypeA = await prototypePage.evaluate(() => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    return element ? { w: Math.round(element.getBoundingClientRect().width), h: Math.round(element.getBoundingClientRect().height) } : null;
  };
  return {
    workbench: box(".workbench"),
    tabStrip: box(".work-tabs"),
    tabLabels: [...document.querySelectorAll(".work-tab")].map((tab) => tab.textContent?.trim() ?? ""),
    closeLabels: [...document.querySelectorAll(".tab-close")].map((button) => button.getAttribute("aria-label")),
    collapseLabel: document.querySelector(".collapse-tools")?.getAttribute("aria-label") ?? null,
    workContentH: box(".work-content"),
    serviceRowH: box(".service-row"),
    hasBrowserOwner: document.querySelector(".browser-owner") !== null,
    hasSnapshot: document.querySelector(".snapshot") !== null,
    serviceRowText: document.querySelector(".service-row")?.innerText.replace(/\s+/g, " ").trim() ?? null,
  };
});
await prototypePage.screenshot({ path: `${OUT}/prototype/1440-prototype-A-rail.png` });
const browserTab = prototypePage.locator(".work-tab", { hasText: "浏览器" });
if ((await browserTab.count()) > 0) {
  await browserTab.first().click();
  await prototypePage.waitForTimeout(250);
}
report.prototypeABrowser = await prototypePage.evaluate(() => ({
  ownerText: document.querySelector(".browser-owner")?.innerText.replace(/\s+/g, " ").trim() ?? null,
  hasSnapshot: document.querySelector(".snapshot") !== null,
  snapshotText: document.querySelector(".snapshot")?.innerText.replace(/\s+/g, " ").trim() ?? null,
  validationHeading: [...document.querySelectorAll(".work-content strong")].map((node) => node.textContent).slice(0, 3),
}));
await prototypePage.screenshot({ path: `${OUT}/prototype/1440-prototype-A-browser.png` });
await prototypeContext.close();

await browser.close();
await writeFile(`${OUT}/tool-rail.json`, `${JSON.stringify(report, null, 2)}\n`);
for (const [key, value] of Object.entries(report.states)) {
  console.log(
    `${key}: rail=${value.railPresent ? value.railW : "off"} workbench=${value.workbenchW ?? "-"} tabs=${value.tabCount} active=${value.activeTab ?? "-"} rows=${value.rows.length} endpointsVisible=${value.rows.filter((row) => row.endpointFullyVisible).length} noOverflow=${value.noHorizontalOverflow}`,
  );
}
console.log(`prototype A: ${JSON.stringify(report.prototypeA)}`);
