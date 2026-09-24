// [UI 对齐 02] (#26) evidence: the shell and task layout tiers at the prototype's
// breakpoints (1180/960/850/720, `prototypes/pidock-ui/style.css`).
//
// Run: node docs/evidence/ui-alignment-layout/capture-layout.mjs
// Needs: the renderer dev server on http://127.0.0.1:4335 and a built renderer
// dist (pnpm --filter @pidock/renderer build) for the breakpoint check.
// Outputs are written next to this script: renderer/*.png, geometry.json,
// css-breakpoints.json.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/adber/workspace/github/PiDock/packages/renderer/node_modules/playwright-core/index.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const RENDERER = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const TASK_URL = `${RENDERER}/projects/atlas/tasks/release?session=main`;
const DIST_CSS_DIR = fileURLToPath(new URL("../../../packages/renderer/dist/assets/", import.meta.url));
// The five tiers the ticket asks screenshots for.
const WIDTHS = [1600, 1280, 1180, 1024, 960, 800, 720];
/** 1180 and 800 are boundary probes: geometry only, no screenshot. */
const SHOT_WIDTHS = [1600, 1280, 1024, 960, 720];
const HEIGHT = 900;
const BREAKPOINTS = [1180, 960, 850, 720];
/** Prototype `@media(max-width:960px)` keeps these buttons reachable in the rail. */
const RAIL_LABELS = ["项目总览", "环境与服务", "Token 用量", "已归档", "定时任务", "能力管理", "远程访问", "本机设置", "模型与 Provider"];

await mkdir(join(OUT, "renderer"), { recursive: true });

async function measure(page, state) {
  const inPage = await page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
    };
    const sidebar = document.querySelector('[data-testid="shell-sidebar"]');
    const rail = document.querySelector('[data-testid="task-rail"]');
    const subagent = document.querySelector('[data-testid="subagent-sidebar"]');
    const messages = document.querySelector('[role="log"][aria-label="会话消息"]');
    const pageContainer = document.querySelector('[data-testid="breadcrumb"]')?.nextElementSibling ?? null;
    // A label is visible when its box is more than the `sr-only` clip (1x1).
    const visibleLabelTexts = sidebar
      ? [...sidebar.querySelectorAll("button > span")]
          .filter((span) => {
            const box = span.getBoundingClientRect();
            return box.width > 2 && box.height > 2;
          })
          .map((span) => (span.textContent || "").trim())
          .filter((text) => text.length > 0)
      : [];
    return {
      mediaMatches: {
        "max-width:1180px": window.matchMedia("(max-width: 1180px)").matches,
        "max-width:960px": window.matchMedia("(max-width: 960px)").matches,
        "max-width:850px": window.matchMedia("(max-width: 850px)").matches,
        "max-width:720px": window.matchMedia("(max-width: 720px)").matches,
      },
      sidebar: rect(sidebar),
      sidebarComputedWidth: sidebar ? getComputedStyle(sidebar).width : null,
      visibleLabelTexts,
      taskBody: rect(document.querySelector('[data-testid="task-body"]')),
      workspace: rect(document.querySelector('[data-testid="task-workspace"]')),
      rail: rect(rail),
      subagent: rect(subagent),
      subagentInsideRail: Boolean(rail && subagent && rail.contains(subagent)),
      messages: rect(messages),
      pageContainer: rect(pageContainer),
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });

  // Accessible names must survive the icon rail: resolve every nav button by
  // role + name in the real browser.
  const accessibleNames = {};
  for (const label of RAIL_LABELS) {
    accessibleNames[label] = await page.getByRole("button", { name: label, exact: true }).count();
  }
  accessibleNames["需要处理(n)"] = await page.getByRole("button", { name: /^需要处理/ }).count();

  return { state, ...inPage, accessibleNames };
}

async function capture(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(TASK_URL, { waitUntil: "load" });
  await page.getByRole("heading", { name: "发布前检查" }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);

  const shots = [];
  const shootEnabled = SHOT_WIDTHS.includes(width);
  const shot = async (name) => {
    if (!shootEnabled) return;
    const file = join(OUT, "renderer", `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(`renderer/${name}.png`);
  };

  // State 1: subagent panel only — the rail must use the subagent sidebar's own
  // geometry (40% / min 340px / max 520px).
  await page.getByRole("button", { name: /查看 Subagent/ }).click();
  await page.waitForTimeout(300);
  const subagentOnly = await measure(page, "subagent");

  // State 2: tool rail + subagent panel — the rail keeps the tool geometry and
  // both panels live in the same column (no second right-hand column).
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.waitForTimeout(300);
  const both = await measure(page, "both");
  await shot(`${width}-both`);

  // The stacked tier scrolls: capture the rail that lives below the conversation.
  if (width <= 720) {
    await page.evaluate(() => {
      const scroller = [...document.querySelectorAll("main div")].find(
        (element) => element.scrollHeight > element.clientHeight + 40 && getComputedStyle(element).overflowY === "auto",
      );
      if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(250);
    await shot(`${width}-both-scrolled`);
  }

  // State 3: tool rail only.
  await page.getByRole("button", { name: /查看 Subagent/ }).click();
  await page.waitForTimeout(300);
  const tools = await measure(page, "tools");
  await shot(`${width}-tools`);

  await page.close();
  return { width, pageErrors: errors, shots, states: [subagentOnly, both, tools] };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const captures = [];
for (const width of WIDTHS) captures.push(await capture(browser, width));

// The Shell page padding changes with the tier too, so sweep the other pages for
// horizontal overflow at the two outer tiers and the compact one.
const routes = [
  "/attention",
  "/env",
  "/providers",
  "/usage",
  "/settings",
  "/capabilities",
  "/remote",
  "/schedules",
  "/archive",
  "/projects/atlas",
];
const pageSweep = [];
for (const width of [1600, 1024, 720]) {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
  for (const route of routes) {
    await page.goto(`${RENDERER}${route}`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    pageSweep.push({
      width,
      route,
      ...(await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }))),
    });
  }
  await page.close();
}
await browser.close();

// The prototype breakpoints must reach the built CSS as `max-width` queries with
// the prototype's numbers — not Tailwind's default tier values.
const cssFiles = (await readdir(DIST_CSS_DIR)).filter((name) => name.endsWith(".css"));
const css = (await readFile(join(DIST_CSS_DIR, cssFiles[0]), "utf8")).replace(/\n/g, "");
const blocks = [...css.matchAll(/@media\(max-width:(\d+)px\)\{/g)].map((match) => match[1]);
const expectedClasses = {
  1180: ["below-wide\\:w-\\[192px\\]", "below-wide\\:w-\\[40\\%\\]", "below-wide\\:min-w-\\[310px\\]"],
  960: ["below-mid\\:w-16", "below-mid\\:sr-only", "below-mid\\:hidden", "below-mid\\:min-w-\\[290px\\]", "below-mid\\:justify-center", "below-mid\\:px-2"],
  850: ["below-narrow\\:w-\\[45\\%\\]", "below-narrow\\:min-w-\\[300px\\]"],
  720: ["below-stack\\:block", "below-stack\\:w-full", "below-stack\\:min-h-\\[550px\\]", "below-stack\\:min-h-\\[500px\\]"],
};
const found = {};
for (const [breakpoint, classes] of Object.entries(expectedClasses)) {
  const block = new RegExp(`@media\\(max-width:${breakpoint}px\\)\\{([^@]*)`).exec(css)?.[1] ?? "";
  found[breakpoint] = Object.fromEntries(classes.map((token) => [token, block.includes(`.${token}`)]));
}
const missing = Object.entries(found).flatMap(([breakpoint, tokens]) =>
  Object.entries(tokens)
    .filter(([, present]) => !present)
    .map(([token]) => `${breakpoint}px ${token}`),
);
const cssReport = {
  file: `packages/renderer/dist/assets/${cssFiles[0]}`,
  mediaQueriesInOrder: blocks,
  prototypeBreakpointsPresent: BREAKPOINTS.every((breakpoint) => blocks.includes(String(breakpoint))),
  missingUtilities: missing,
  found,
};
await writeFile(join(OUT, "css-breakpoints.json"), `${JSON.stringify(cssReport, null, 2)}\n`);

const geometry = {
  rendererBase: RENDERER,
  taskUrl: TASK_URL,
  viewportHeight: HEIGHT,
  prototypeBreakpoints: BREAKPOINTS,
  captures,
  pageSweep,
};
await writeFile(join(OUT, "geometry.json"), `${JSON.stringify(geometry, null, 2)}\n`);

console.log(JSON.stringify(cssReport, null, 2));
for (const capture of captures) {
  const [subagent, both, tools] = capture.states;
  console.log(
    `${capture.width}: sidebar=${tools.sidebar?.w} rail(tools)=${tools.rail?.w} rail(subagent)=${subagent.rail?.w} conversation=${tools.workspace?.w} messages=${tools.messages?.h} both: subagentInRail=${both.subagentInsideRail} subagentH=${both.subagent?.h} noOverflow=${tools.noHorizontalOverflow}/${both.noHorizontalOverflow} errors=${capture.pageErrors.length}`,
  );
}
const overflow = pageSweep.filter((row) => !row.noHorizontalOverflow);
console.log(`page sweep: ${pageSweep.length} route/viewport pairs, ${overflow.length} overflowing`);
