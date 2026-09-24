// [UI 对齐 03] (#27) vertical budget + horizontal sanity measurement.
//
// Measures the task workspace block by block in headless Chromium (jsdom has no
// layout) and writes the numbers the acceptance items are checked against. Run
// with the renderer dev server on 4335:
//
//   node docs/evidence/ui-alignment-s2/capture-vertical.mjs
//
// Images and JSON are written next to this file so the evidence stays
// reproducible from the repository (same convention as `ui-alignment-s1`).

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
const PANELS = ["运行", "协议", "浏览器", "文件", "终端", "日志"];
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
];

/**
 * The ≥400px message-area floor from [UI 对齐 03] (#27) is measured in the state
 * it was accepted in: **no execution status card on screen**. [UI 对齐 05] (#29)
 * added the cross-session card (an idle session shows it while another session
 * of the same task is running or waiting), and that card legitimately takes its
 * height out of the message area, where the tiered 340/300px floors apply
 * instead. So this script records the card per state and asserts the *equivalent
 * card-free* height, which is what stays comparable with #27.
 */
const MESSAGES_FLOOR_NO_CARD = 400;

const measure = (page) =>
  page.evaluate(() => {
    const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
    const section = document.querySelector('[data-testid="task-workspace"]');
    const messages = document.querySelector('[role="log"][aria-label="会话消息"]');
    const composer = document.querySelector('[data-testid="task-composer"]');
    const header = document.querySelector('[data-testid^="task-header-"]');
    // The tab strip is `overflow-hidden`, so a clipped tab never shows up in
    // `documentElement.scrollWidth`; measure the strip itself (#27 review note).
    const tabStrip = document.querySelector('[data-testid="session-tab-strip"]');
    // [UI 对齐 05] (#29): the cross-session execution card shares this flex
    // column, so a state that carries one cannot be compared with #27's numbers
    // without saying so.
    const card = document.querySelector('[aria-label="会话执行状态"]');
    const gap = section ? Number.parseFloat(getComputedStyle(section).rowGap) : Number.NaN;
    const cardH = box(card);
    const messagesH = box(messages);
    const rows = [...(section?.children ?? [])].map((element) => ({
      tag: element.tagName.toLowerCase(),
      testid: element.getAttribute("data-testid") ?? null,
      h: box(element),
      text: (element.innerText ?? "").replace(/\s+/g, " ").slice(0, 40),
    }));
    return {
      viewport: { w: innerWidth, h: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      headerH: box(header),
      messagesH,
      messagesShare: messages ? Number((messages.getBoundingClientRect().height / innerHeight).toFixed(3)) : null,
      composerH: box(composer),
      // The card's own height and the equivalent no-card message height, so a
      // reader (and the assertion below) can tell the two bases apart.
      cardH,
      cardText: card ? (card.innerText ?? "").replace(/\s+/g, " ").slice(0, 40) : null,
      cardFreeGap: cardH === null ? null : (Number.isFinite(gap) ? gap : 0),
      cardFreeMessagesH:
        messagesH === null ? null : Math.round(messagesH + (cardH ?? 0) + (cardH === null ? 0 : Number.isFinite(gap) ? gap : 0)),
      sectionH: box(section),
      tabStrip: tabStrip
        ? {
            scrollWidth: tabStrip.scrollWidth,
            clientWidth: tabStrip.clientWidth,
            noClip: tabStrip.scrollWidth <= tabStrip.clientWidth,
          }
        : null,
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
  await page.waitForTimeout(300);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { taskUrl: TASK_URL, states: {}, panels: PANELS };
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(TASK_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await openPanels(page, []);
  report.states[`${viewport.name}-closed`] = await measure(page);
  if (viewport.name === "1440x900") await page.screenshot({ path: `${OUT}/renderer/1440-closed.png` });

  await openPanels(page, [PANELS[0]]);
  report.states[`${viewport.name}-one`] = await measure(page);
  await page.screenshot({ path: `${OUT}/renderer/${viewport.width}-one-panel.png` });

  await openPanels(page, PANELS.slice(1));
  report.states[`${viewport.name}-all`] = await measure(page);
  if (viewport.name === "1440x900") await page.screenshot({ path: `${OUT}/renderer/1440-all-panels.png` });
  await context.close();
}

// The `任务操作` menu and the ordinary-directory header, captured at the same
// viewport so the mapping table in the log has a picture next to it.
const menuContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const menuPage = await menuContext.newPage();
await menuPage.goto(TASK_URL, { waitUntil: "networkidle" });
await menuPage.waitForTimeout(400);
await menuPage.getByRole("button", { name: "任务操作" }).click();
await menuPage.waitForTimeout(200);
await menuPage.screenshot({ path: `${OUT}/renderer/1440-task-menu.png` });
report.menuItems = await menuPage.evaluate(() =>
  [...document.querySelectorAll('[data-testid="task-action-menu"] [role="menuitem"]')].map((item) => item.textContent),
);
await menuPage.goto(`${RENDERER}/projects/atlas/tasks/design-docs?session=main`, { waitUntil: "networkidle" });
await menuPage.waitForTimeout(400);
await menuPage.screenshot({ path: `${OUT}/renderer/1440-directory-task.png` });
report.directoryHeader = await menuPage.evaluate(() => {
  const header = document.querySelector('[data-testid^="task-header-"]');
  return {
    eyebrow: header?.querySelector("div")?.textContent?.trim() ?? null,
    text: (header?.innerText ?? "").replace(/\s+/g, " ").slice(0, 200),
    worktreeMentioned: /worktree/.test(header?.innerText ?? ""),
  };
});
await menuContext.close();

// Prototype A at the same viewport: the reference numbers the acceptance
// compares against, measured in this same harness (`.taskheader`, `.meta`,
// `.messages`, `.composer-wrap`, `.workbench`).
const prototypeContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const prototypePage = await prototypeContext.newPage();
await prototypePage.goto(`${PROTOTYPE_URL}/?variant=A`, { waitUntil: "networkidle" });
await prototypePage.waitForTimeout(600);
report.prototypeA = await prototypePage.evaluate(() => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    return element ? Math.round(element.getBoundingClientRect().height) : null;
  };
  return {
    headerH: box(".taskheader"),
    metaH: box(".taskheader .meta"),
    sessionsH: box(".sessions"),
    subagentsH: box(".session-subagents"),
    messagesH: box(".messages"),
    composerH: box(".composer-wrap"),
    workbenchW: (() => {
      const element = document.querySelector(".workbench");
      return element ? Math.round(element.getBoundingClientRect().width) : null;
    })(),
    eyebrow: document.querySelector(".view-label")?.textContent?.trim() ?? null,
  };
});
await prototypePage.screenshot({ path: `${OUT}/prototype/1440-prototype-A.png` });
await prototypeContext.close();

await browser.close();

// The cross-reference assertion the review of [UI 对齐 08] (#32) asked for: the
// card-free message height must stay at or above #27's floor. Without it the S2
// number can slide (or change basis) with every later slice and still look
// green — which is exactly what happened between the refresh in `b410e6b` and
// this round's measurement.
report.assertions = { checked: 0, violations: [], floor: { cardFree: MESSAGES_FLOOR_NO_CARD } };
for (const [key, value] of Object.entries(report.states)) {
  // The floor was accepted for the 1440×900 column; the narrower tiers sit in an
  // 800px-tall viewport and are recorded, not floored ([UI 对齐 05] #29 ruling).
  if (!key.startsWith("1440x900")) continue;
  report.assertions.checked += 1;
  if (value.cardFreeMessagesH !== null && value.cardFreeMessagesH < MESSAGES_FLOOR_NO_CARD) {
    report.assertions.violations.push(
      `${key}: card-free message area ${value.cardFreeMessagesH}px < the ${MESSAGES_FLOOR_NO_CARD}px floor from [UI 对齐 03] (#27)`,
    );
  }
}

await writeFile(`${OUT}/vertical-budget.json`, `${JSON.stringify(report, null, 2)}\n`);
for (const [key, value] of Object.entries(report.states)) {
  console.log(
    `${key}: header=${value.headerH} messages=${value.messagesH} (${value.messagesShare}) card=${value.cardH ?? "-"} ` +
      `cardFree=${value.cardFreeMessagesH} composer=${value.composerH} overflow=${!value.noHorizontalOverflow} ` +
      `tabStripClip=${value.tabStrip ? !value.tabStrip.noClip : "n/a"}`,
  );
}
console.log(`prototype A 1440x900: ${JSON.stringify(report.prototypeA)}`);
console.log(`menu: ${JSON.stringify(report.menuItems)}`);
console.log(`directory header: ${JSON.stringify(report.directoryHeader)}`);
console.log(
  `assertions: ${report.assertions.violations.length === 0 ? "ok" : "FAILED"} ` +
    `(${report.assertions.checked} card-free floor checks at ${MESSAGES_FLOOR_NO_CARD}px)`,
);
for (const violation of report.assertions.violations) console.log(`  - ${violation}`);
console.log(`wrote ${OUT}/vertical-budget.json`);
process.exit(report.assertions.violations.length === 0 ? 0 : 1);
