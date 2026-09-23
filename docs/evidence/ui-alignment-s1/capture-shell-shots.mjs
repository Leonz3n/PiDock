// [UI 对齐 01] (#25) evidence: renderer shell screenshots next to prototype A.
// Run: node docs/evidence/ui-alignment-s1/capture-shell-shots.mjs
// Needs the prototype on http://127.0.0.1:4319 and the renderer dev server on
// http://127.0.0.1:4335 (see verification-log.md §1).
// Outputs are written next to this script, not to a temp dir: prototype shots
// into prototype/, renderer shots into renderer/, and the facts JSON into this
// directory.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/adber/workspace/github/PiDock/packages/renderer/node_modules/playwright-core/index.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};

// Same file names the directory ships with: `prototype/prototype-A.png` and
// `renderer/shell-<page>.png` (the callers prefix the facts keys with
// `renderer-`, which is not part of the committed file name).
async function shoot(name, url, waitFor) {
  const subdir = name.startsWith("prototype") ? "prototype" : "renderer";
  const fileName = name.replace(/^renderer-/, "");
  await mkdir(join(OUT, subdir), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "load" });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, subdir, `${fileName}.png`) });
  const facts = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="shell-sidebar"], .sidebar');
    const breadcrumb = document.querySelector('[data-testid="breadcrumb"], .topbar');
    const summary = document.querySelector('[data-testid="shell-summary"], .switcher');
    const groups = [...(document.querySelectorAll("[data-nav-group]") ?? [])].map((group) => ({
      group: group.getAttribute("data-nav-group"),
      items: [...group.querySelectorAll("button")].map((button) => (button.textContent || "").trim()),
    }));
    return {
      sidebarText: (sidebar?.innerText || "").replace(/\n+/g, " | "),
      breadcrumbText: (breadcrumb?.innerText || "").replace(/\n+/g, " / "),
      summaryText: (summary?.innerText || "").replace(/\n+/g, " | "),
      groups,
      switcherPresent: /布局探索|对话优先|运行优先|验证优先/.test(document.body.innerText),
      pageErrors: undefined,
    };
  });
  report[name] = { url, ...facts, pageErrors: errors };
  await page.close();
  console.log(name, JSON.stringify(report[name].pageErrors));
}

await shoot("prototype-A", "http://127.0.0.1:4319/?variant=A", null);
await shoot("renderer-shell-attention", "http://127.0.0.1:4335/attention", '[data-testid="shell-sidebar"]');
await shoot("renderer-shell-task", "http://127.0.0.1:4335/projects/atlas/tasks/release?session=main", '[data-testid="shell-sidebar"]');
await shoot("renderer-shell-env", "http://127.0.0.1:4335/env", '[data-testid="shell-sidebar"]');

await browser.close();
const { writeFile } = await import("node:fs/promises");
await writeFile(join(OUT, "shell-facts.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
