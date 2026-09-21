import { chromium } from "playwright-core";

/**
 * Anchor-follow check for the conversation log. jsdom has no layout, so this
 * runs against the real dev server: it asserts the log follows streaming
 * output only while the user is pinned to the bottom, and stays put once the
 * user scrolls up. Exits non-zero when any expectation fails.
 *
 * Usage: node packages/renderer/scripts/verify-anchor.mjs
 * Requires the renderer dev server on RENDERER_BASE (default 4335).
 */

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const LOG = '[role="log"][aria-label="会话消息"]';

const metrics = (el) => ({
  scrollTop: Math.round(el.scrollTop),
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
  distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
});

async function readLog(page) {
  return page.$eval(LOG, metrics);
}

async function sendMessage(page, text) {
  await page.getByLabel("消息输入").fill(text);
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.waitForFunction((t) => document.querySelector('[role="log"]')?.textContent?.includes(t), text, { timeout: 5000 });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const checks = {};
let failed = false;
const assert = (name, condition, detail) => {
  checks[name] = { pass: Boolean(condition), detail };
  if (!condition) failed = true;
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${BASE}/projects/atlas/tasks/release?session=main`, { waitUntil: "networkidle" });
  await page.waitForSelector(LOG);
  await page.waitForTimeout(250);

  const initial = await readLog(page);
  assert("log-overflows", initial.scrollHeight > initial.clientHeight, initial);
  assert("pinned-to-bottom-on-load", initial.distance <= 48, initial);

  // User scrolls up: the anchor must detach.
  await page.$eval(LOG, (el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const detached = await readLog(page);
  assert("detached-after-scroll-up", detached.distance > 48, detached);

  // New streaming output while detached must not yank the viewport back.
  await sendMessage(page, "锚点验证-未贴底");
  await page.waitForTimeout(700);
  const afterDetachedSend = await readLog(page);
  assert("stays-detached-while-scrolled-up", afterDetachedSend.distance > 48, afterDetachedSend);

  // Re-pin to the bottom: following resumes.
  await page.$eval(LOG, (el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  const repinned = await readLog(page);
  assert("repins-at-bottom", repinned.distance <= 48, repinned);

  await sendMessage(page, "锚点验证-贴底跟随");
  await page.waitForTimeout(700);
  const afterPinnedSend = await readLog(page);
  assert("follows-streaming-while-pinned", afterPinnedSend.distance <= 48, afterPinnedSend);

  checks.pageErrors = errors;
  assert("no-page-errors", errors.length === 0, errors);
  await context.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks, failed }, null, 2));
process.exit(failed ? 1 : 0);
