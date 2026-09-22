import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RENDERER = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const PROTOTYPE = process.env.PROTOTYPE_BASE ?? "http://127.0.0.1:4319/?variant=A";
const OUT = process.env.EVIDENCE_DIR ?? fileURLToPath(new URL("../../../docs/evidence/renderer-baseline-2026-09-22/", import.meta.url));

const rendererPages = [
  { name: "attention", path: "/attention" },
  { name: "project", path: "/projects/atlas" },
  { name: "task-main", path: "/projects/atlas/tasks/release?session=main" },
  { name: "task-deploy", path: "/projects/atlas/tasks/release?session=deploy" },
  { name: "task-failed", path: "/projects/atlas/tasks/release?session=failed" },
  { name: "env", path: "/env" },
  { name: "providers", path: "/providers" },
  { name: "usage", path: "/usage" },
  { name: "schedules", path: "/schedules" },
  { name: "capabilities", path: "/capabilities" },
  { name: "remote", path: "/remote" },
  { name: "archive", path: "/archive" },
  { name: "settings", path: "/settings" },
];

const prototypePages = [
  { name: "project" },
  { name: "task-main", click: '[data-action="task:0"]' },
  { name: "env", click: 'button[data-action="view:env"]' },
  { name: "providers", click: 'button[data-action="view:providers"]' },
  { name: "usage", click: 'button[data-action="view:usage"]' },
  { name: "schedules", click: 'button[data-action="view:schedules"]' },
  { name: "capabilities", click: 'button[data-action="view:capabilities"]' },
  { name: "remote", click: 'button[data-action="view:remote"]' },
  { name: "archive", click: 'button[data-action="view:archive"]' },
];

/**
 * One capture routine for both route-driven renderer pages and click-driven
 * prototype pages. Page errors and console errors are collected per page and
 * returned so the caller can persist them next to the screenshots; the claim
 * "the pages rendered without errors" is only checkable if the errors are kept.
 */
async function captureScreens(browser, { base, dir, pages }) {
  const target = `${OUT}${dir}/`;
  await mkdir(target, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push({ page: page.url(), kind: "pageerror", message: String(error) }));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ page: page.url(), kind: "console", message: message.text() });
  });
  await page.goto(base, { waitUntil: "networkidle" });
  for (const { name, path, click } of pages) {
    if (path) await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    if (click) {
      await page.click(click);
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
  const rendererErrors = await captureScreens(browser, { base: RENDERER, dir: "renderer", pages: rendererPages });
  const prototypeErrors = await captureScreens(browser, { base: PROTOTYPE, dir: "prototype", pages: prototypePages });
  const report = { rendererErrors, prototypeErrors };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}capture-errors.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}capture-errors.json`);
  if (rendererErrors.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
