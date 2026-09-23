// [UI 对齐 01] (#25) evidence: machine-checked shell facts for the fix round.
// Runs the renderer dev build and the prototype in headless Chromium, reads the
// computed styles + text the reviewer compared by eye, and drives the keyboard
// rename path in a real browser: the ContextMenu key makes Chromium dispatch
// `contextmenu` on the focused element, which jsdom cannot reproduce.
// Run: node docs/evidence/ui-alignment-s1/verify-shell-facts.mjs
// Needs the prototype on http://127.0.0.1:4319 and the renderer dev server on
// http://127.0.0.1:4335 (see verification-log.md §1).
// The JSON is written next to this script, not to a temp dir.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/adber/workspace/github/PiDock/packages/renderer/node_modules/playwright-core/index.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};

async function page(url, waitFor) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.goto(url, { waitUntil: "load" });
  if (waitFor) await p.waitForSelector(waitFor, { timeout: 15000 });
  await p.waitForTimeout(500);
  return { p, errors, close: () => context.close() };
}

// 1. Prototype A: the effective `.switcher` values (line 1 base rule vs the
//    line 10 review-revision override) — the reviewer compared against the
//    superseded base rule, so read what the browser actually applies.
{
  const { p, errors, close } = await page("http://127.0.0.1:4319/?variant=A", ".switcher");
  const serialized = await p.evaluate(() => {
    const pickComputed = (el, props) => Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el)[prop]]));
    const switcher = document.querySelector(".switcher");
    const state = switcher.querySelector(".state");
    return {
      switcher: pickComputed(switcher, ["backgroundColor", "borderColor", "color", "borderRadius", "padding", "gap", "boxShadow", "fontSize", "bottom"]),
      state: pickComputed(state, ["color"]),
    };
  });
  report.prototypeSwitcher = { ...serialized, pageErrors: errors };
  await close();
}

// 2. Renderer task page: dot halo, summary bar, nav wording source, keyboard rename.
{
  const { p, errors, close } = await page(
    "http://127.0.0.1:4335/projects/atlas/tasks/release?session=main",
    '[data-testid="shell-sidebar"]',
  );
  const facts = await p.evaluate(() => {
    const pickComputed = (el, props) => Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el)[prop]]));
    const sidebar = document.querySelector('[data-testid="shell-sidebar"]');
    const summary = document.querySelector('[data-testid="shell-summary"]');
    const cards = [...sidebar.querySelectorAll("[data-task-nav]")];
    const running = cards.filter((card) => card.dataset.servicesRunning === "true");
    const dot = running[0]?.querySelector("span[aria-hidden]");
    const navButtons = [...sidebar.querySelectorAll('[data-nav-group] button')];
    return {
      navItems: navButtons.map((button) => ({
        text: button.textContent.trim(),
        title: button.getAttribute("title"),
        ariaLabel: button.getAttribute("aria-label"),
      })),
      cardDots: cards.map((card) => ({
        task: card.dataset.taskNav,
        running: card.dataset.servicesRunning,
        accent: card.querySelector("span[aria-hidden]").className,
      })),
      runningDotStyle: dot ? pickComputed(dot, ["backgroundColor", "boxShadow", "width", "height"]) : null,
      cardButtonsInsideCard: cards.map((card) => card.querySelectorAll("button").length),
      summaryStyle: summary
        ? pickComputed(summary, ["backgroundColor", "borderColor", "color", "borderRadius", "padding", "boxShadow", "fontSize", "bottom"])
        : null,
      summaryText: summary?.innerText.replace(/\n+/g, " | ") ?? null,
      switcherPresent: /布局探索|对话优先|运行优先|验证优先/.test(document.body.innerText),
      tabbarPresent: /variant=B|variant=C/.test(document.body.className),
    };
  });

  // The real keyboard path: focus the card, then press the keyboard's context
  // menu keys. Chromium turns them into `contextmenu` on the focused element,
  // the same event a right-click sends.
  const card = p.locator('[data-nav-group="tasks"] [data-task-nav="release"]');
  const keyboard = {};
  for (const key of ["ContextMenu", "Shift+F10"]) {
    await p.keyboard.press("Escape");
    await p.waitForTimeout(150);
    await card.focus();
    keyboard[`${key}Focus`] = await p.evaluate(() => document.activeElement?.dataset?.taskNav ?? null);
    await p.keyboard.press(key);
    await p.waitForTimeout(400);
    keyboard[key] = await p.evaluate(() => ({
      dialogLabel: document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? null,
      dialogText: (document.querySelector('[role="dialog"]')?.innerText ?? "").replace(/\n+/g, " | ").slice(0, 120),
    }));
  }

  report.rendererTask = { ...facts, keyboard, pageErrors: errors };
  await close();
}

await browser.close();
await writeFile(join(OUT, "shell-verification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
