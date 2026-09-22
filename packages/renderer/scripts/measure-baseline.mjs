import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const OUT = process.env.EVIDENCE_DIR ?? fileURLToPath(new URL("../../../docs/evidence/renderer-baseline-2026-09-22/", import.meta.url));

/**
 * Windowed row count reported by a `VirtualList`. `expected` is derived here,
 * independently of the component, from the viewport geometry the component
 * exposes, so a collapse (e.g. the old border-box feedback loop that shrank
 * 420 → 418 → 416 …) shows up as `rendered !== expected` instead of being
 * published as a measurement.
 */
function listMetrics(element) {
  const total = Number(element.getAttribute("data-total-rows"));
  const viewportHeight = Number(element.getAttribute("data-viewport-height"));
  const rowHeight = Number(element.getAttribute("data-row-height"));
  const overscan = Number(element.getAttribute("data-overscan"));
  const expectedAttribute = element.getAttribute("data-expected-rows");
  const expected = Math.min(total, Math.ceil(viewportHeight / rowHeight) + overscan);
  return {
    total,
    virtualized: element.getAttribute("data-virtualized"),
    viewportHeight,
    rowHeight,
    overscan,
    expected,
    expectedAttribute: Number(expectedAttribute),
    rendered: element.querySelectorAll('[style*="translateY"]').length,
  };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(`${BASE}/attention`, { waitUntil: "networkidle" });
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const heading = document.querySelector("h1");
    const shell = document.querySelector("#root > div");
    return {
      accent: root.getPropertyValue("--color-accent").trim(),
      bg: root.getPropertyValue("--color-bg").trim(),
      ink: root.getPropertyValue("--color-ink").trim(),
      radiusPanel: root.getPropertyValue("--radius-panel").trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      shellBackground: shell ? getComputedStyle(shell).backgroundColor : null,
      headingText: heading?.textContent?.trim() ?? null,
      headingColor: heading ? getComputedStyle(heading).color : null,
    };
  });

  await page.goto(`${BASE}/usage`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="usage-table"]');
  // Let the resize observer settle so a feedback loop would have collapsed the
  // viewport before the measurement is taken.
  await page.waitForTimeout(500);
  const usage = await page.$eval('[data-testid="usage-table"]', listMetrics);

  await page.goto(`${BASE}/projects/atlas/tasks/release?session=main`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /全部会话/ }).click();
  await page.waitForSelector('[data-testid="session-list"]');
  await page.waitForTimeout(300);
  const sessions = await page.$eval('[data-testid="session-list"]', listMetrics);
  // The session tabs are the documented small-set exemption: at most four, never virtualized.
  const sessionTabs = await page.$$eval('button[title$="· 右键操作"]', (elements) => elements.length);

  await page.goto(`${BASE}/schedules`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="run-history"]');
  await page.waitForTimeout(300);
  const runHistory = await page.$eval('[data-testid="run-history"]', listMetrics);

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  const settings = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const input = document.querySelector('input[aria-label="默认任务根目录"]');
    return {
      heading: heading?.textContent?.trim() ?? null,
      workspaceRoot: input?.value ?? null,
      showsConfigDir: document.body.textContent?.includes("~/.pi/dock") ?? false,
    };
  });

  const lists = { usage, sessions, runHistory };
  const expectationMismatches = Object.entries(lists)
    .filter(([, list]) => list.rendered !== list.expected || list.expectedAttribute !== list.expected)
    .map(([name, list]) => ({
      list: name,
      expected: list.expected,
      rendered: list.rendered,
      expectedAttribute: list.expectedAttribute,
    }));

  const report = { tokens, usage, sessions, sessionTabs, runHistory, settings, errors, expectationMismatches };
  console.log(JSON.stringify(report, null, 2));

  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}measurements.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${OUT}measurements.json`);

  if (expectationMismatches.length > 0) {
    console.error(`rendered row count does not match ceil(viewportHeight / rowHeight) + overscan: ${JSON.stringify(expectationMismatches)}`);
    process.exitCode = 1;
  }
  if (errors.length > 0) {
    console.error(`renderer reported ${errors.length} error(s); see measurements.json`);
    process.exitCode = 1;
  }
  await context.close();
} finally {
  await browser.close();
}
