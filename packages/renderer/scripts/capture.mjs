import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RENDERER = "http://127.0.0.1:4335";
const PROTOTYPE = "http://127.0.0.1:4319/?variant=A";
const OUT = fileURLToPath(new URL("../../../docs/evidence/renderer-baseline-2026-09-22/", import.meta.url));

const rendererPages = [
  ["attention", "/attention"],
  ["project", "/projects/atlas"],
  ["task-main", "/projects/atlas/tasks/release?session=main"],
  ["task-deploy", "/projects/atlas/tasks/release?session=deploy"],
  ["task-failed", "/projects/atlas/tasks/release?session=failed"],
  ["env", "/env"],
  ["providers", "/providers"],
  ["usage", "/usage"],
  ["schedules", "/schedules"],
  ["capabilities", "/capabilities"],
  ["remote", "/remote"],
  ["archive", "/archive"],
];

const prototypePages = [
  ["project", null],
  ["task-main", '[data-action="task:0"]'],
  ["env", 'button[data-action="view:env"]'],
  ["providers", 'button[data-action="view:providers"]'],
  ["usage", 'button[data-action="view:usage"]'],
  ["schedules", 'button[data-action="view:schedules"]'],
  ["capabilities", 'button[data-action="view:capabilities"]'],
  ["remote", 'button[data-action="view:remote"]'],
  ["archive", 'button[data-action="view:archive"]'],
];

async function captureRoutes(browser, base, pages, dir) {
  const target = `${OUT}${dir}/`;
  await mkdir(target, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  for (const [name, path] of pages) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${target}${name}.png` });
    console.log(`${dir}/${name}.png`);
  }
  await context.close();
  return errors;
}

async function capture(browser, base, pages, dir) {
  const target = `${OUT}${dir}/`;
  await mkdir(target, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: "networkidle" });
  for (const [name, selector] of pages) {
    if (selector) {
      await page.click(selector);
      await page.waitForTimeout(180);
    }
    await page.screenshot({ path: `${target}${name}.png` });
    console.log(`${dir}/${name}.png`);
  }
  await context.close();
  return errors;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const rendererErrors = await captureRoutes(browser, RENDERER, rendererPages, "renderer");
  const prototypeErrors = await capture(browser, PROTOTYPE, prototypePages, "prototype");
  console.log(JSON.stringify({ rendererErrors, prototypeErrors }, null, 2));
} finally {
  await browser.close();
}
