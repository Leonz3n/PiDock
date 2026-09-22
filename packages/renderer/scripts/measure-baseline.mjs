import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { CHROME, EVIDENCE_DIR, RENDERER_BASE, VIEWPORT } from "./evidence.mjs";

/**
 * Windowed row count reported by a `VirtualList`.
 *
 * `declaredHeight` is the height the caller asked for, published separately
 * from `viewportHeight` (the height actually measured). Asserting
 * `viewportHeight === declaredHeight` is what catches a collapsing list: if the
 * component shrank, both the rendered rows and the viewport would shrink in
 * lockstep and `rendered === expected` could keep holding. `expected` is
 * derived here from `viewportHeight` independently of the component's own
 * `data-expected-rows`, and the two are cross-checked so the Node formula and
 * the shared `viewportWindowSize()` cannot drift apart silently.
 */
function listMetrics(element) {
  const total = Number(element.getAttribute("data-total-rows"));
  const declaredHeight = Number(element.getAttribute("data-declared-height"));
  const viewportHeight = Number(element.getAttribute("data-viewport-height"));
  const rowHeight = Number(element.getAttribute("data-row-height"));
  const overscan = Number(element.getAttribute("data-overscan"));
  const expectedAttribute = Number(element.getAttribute("data-expected-rows"));
  const expected = Math.min(total, Math.ceil(viewportHeight / rowHeight) + overscan);
  return {
    total,
    virtualized: element.getAttribute("data-virtualized"),
    declaredHeight,
    viewportHeight,
    rowHeight,
    overscan,
    expected,
    expectedAttribute,
    rendered: element.querySelectorAll('[style*="translateY"]').length,
    heightMatchesDeclared: viewportHeight === declaredHeight,
    rowsMatchExpected: element.querySelectorAll('[style*="translateY"]').length === expected,
  };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(`${RENDERER_BASE}/attention`, { waitUntil: "networkidle" });
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

  await page.goto(`${RENDERER_BASE}/usage`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="usage-table"]');
  // Let the resize observer settle so a feedback loop would have collapsed the
  // viewport before the measurement is taken.
  await page.waitForTimeout(500);
  const usage = await page.$eval('[data-testid="usage-table"]', listMetrics);

  await page.goto(`${RENDERER_BASE}/projects/atlas/tasks/release?session=main`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /全部会话/ }).click();
  await page.waitForSelector('[data-testid="session-list"]');
  await page.waitForTimeout(300);
  const sessions = await page.$eval('[data-testid="session-list"]', listMetrics);
  // The session tabs are the documented small-set exemption: at most four, never virtualized.
  const sessionTabs = await page.$$eval('button[title$="· 右键操作"]', (elements) => elements.length);

  await page.goto(`${RENDERER_BASE}/schedules`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="run-history"]');
  await page.waitForTimeout(300);
  const runHistory = await page.$eval('[data-testid="run-history"]', listMetrics);

  await page.goto(`${RENDERER_BASE}/settings`, { waitUntil: "networkidle" });
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
    .filter(
      ([, list]) =>
        !list.heightMatchesDeclared || !list.rowsMatchExpected || list.expectedAttribute !== list.expected,
    )
    .map(([name, list]) => ({
      list: name,
      declaredHeight: list.declaredHeight,
      viewportHeight: list.viewportHeight,
      expected: list.expected,
      rendered: list.rendered,
      expectedAttribute: list.expectedAttribute,
      heightMatchesDeclared: list.heightMatchesDeclared,
      rowsMatchExpected: list.rowsMatchExpected,
    }));

  const report = { tokens, usage, sessions, sessionTabs, runHistory, settings, errors, expectationMismatches };
  console.log(JSON.stringify(report, null, 2));

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(`${EVIDENCE_DIR}measurements.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${EVIDENCE_DIR}measurements.json`);

  if (expectationMismatches.length > 0) {
    console.error(
      `virtual list window mismatch (viewportHeight must equal declaredHeight and rendered must equal ceil(viewportHeight/rowHeight)+overscan): ${JSON.stringify(
        expectationMismatches,
      )}`,
    );
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
