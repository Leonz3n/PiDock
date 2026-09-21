import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";

function rowCounts(element) {
  return {
    total: Number(element.getAttribute("data-total-rows")),
    virtualized: element.getAttribute("data-virtualized"),
    rendered: element.querySelectorAll('[style*="translateY"]').length,
  };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

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
  const usage = await page.$eval('[data-testid="usage-table"]', rowCounts);

  await page.goto(`${BASE}/projects/atlas/tasks/release?session=main`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /全部会话/ }).click();
  await page.waitForSelector('[data-testid="session-list"]');
  const sessions = await page.$eval('[data-testid="session-list"]', rowCounts);
  // The session tabs are the documented small-set exemption: at most four, never virtualized.
  const sessionTabs = await page.$$eval('button[title$="· 右键操作"]', (elements) => elements.length);

  await page.goto(`${BASE}/schedules`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="run-history"]');
  const runHistory = await page.$eval('[data-testid="run-history"]', rowCounts);

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

  console.log(JSON.stringify({ tokens, usage, sessions, sessionTabs, runHistory, settings, errors }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
