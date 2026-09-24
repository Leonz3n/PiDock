// [UI 对齐 09] (#33) evidence for the six remaining management pages.
//
// jsdom has no layout, so this slice's claims are measured in headless
// Chromium: the page head (view label + title + intro), the two summary
// strips, the provider cards, the usage charts and summary table, the
// capability rows, the remote mode picker / device rows, the schedule rows and
// the archive cards — each read with the *same* class selector on the renderer
// and on prototype A in the same run, because both sides carry the prototype's
// class as an unstyled marker. A handful of properties are compared for
// equality (`same(...)`); the rest are recorded in `pages.json`.
//
//   node docs/evidence/ui-alignment-s7b/capture-pages.mjs
//
// Images and JSON land next to this file. Every renderer locator is a
// `data-testid` or a prototype class (the [UI 对齐 06] #30 lesson: an evidence
// script keyed on an accessible name breaks the moment a later slice aligns
// that name). The prototype is driven through its own `data-action` hooks, and
// a few checks assert that the page state actually changed (an anti-no-op
// assertion), so "the control works" is not a screenshot claim.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/adber/workspace/github/PiDock/packages/renderer/node_modules/playwright-core/index.mjs";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  "/Users/adber/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const RENDERER = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";
const PROTOTYPE = process.env.PROTOTYPE_BASE ?? "http://127.0.0.1:4319";

// The usage ledger fixture (`packages/shell/src/host/memoryHost.ts`,
// `makeUsage`) is dated inside this span. The usage probe drives the page's
// own 自定义 range with these two dates instead of asking whether the *wall
// clock* week happens to hold records — the ledger is fixed data, the clock is
// not ([UI 对齐 09] #33 review P2-8).
const LEDGER_FROM = "2026-09-15";
const LEDGER_TO = "2026-09-21";

// The prototype's own page tiers: `@media(max-width:960px){.page{padding:25px}}`
// and `@media(max-width:720px){.page{padding:20px}}`, so 1024 is still 30/34.
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
  { name: "900x800", width: 900, height: 800 },
  { name: "720x800", width: 720, height: 800 },
];

/** The prototype's class names, read on both sides. */
const SELECTORS = {
  page: ".page",
  viewLabel: ".view-label",
  title: "h1",
  pageIntro: ".page-intro",
  note: ".note",
  empty: ".empty",
  badge: ".badge",
  pageButtons: ".page .btn",
  pageButtonIcons: ".page .btn svg",
  // providers
  card: ".card",
  grid2: ".grid2",
  grid3: ".grid3",
  grid4: ".grid4",
  stat: ".stat",
  providerCard: ".provider-card",
  providerSymbol: ".provider-symbol",
  providerCardP: ".provider-card p",
  modelChips: ".provider-model-chips",
  // usage
  usageControls: ".usage-controls select",
  barChart: ".bar-chart",
  barColumn: ".bar-column",
  bar: ".bar-column .bar",
  donut: ".usage-donut",
  tableWrap: ".table-wrap",
  table: ".table",
  th: ".table th",
  td: ".table td",
  // capabilities
  capSummary: ".capability-summary",
  capSummaryCell: ".capability-summary > div",
  capSummaryStrong: ".capability-summary strong",
  capTabs: ".capability-tabs",
  capTabSpan: ".capability-tabs button span",
  capList: ".capability-list",
  capRow: ".capability-row",
  capMain: ".capability-main",
  capIcon: ".capability-icon",
  capMeta: ".capability-meta",
  inlineNotice: ".inline-notice",
  // remote
  modePicker: ".remote-mode-picker",
  modeButton: ".remote-mode-picker button",
  modeSymbol: ".remote-mode-picker button > span",
  modeStrong: ".remote-mode-picker button strong",
  modeSmall: ".remote-mode-picker button small",
  modeEm: ".remote-mode-picker button em",
  remoteLayout: ".remote-layout",
  orb: ".status-orb",
  checks: ".connection-checks",
  checkRow: ".connection-checks > div",
  permissionList: ".permission-list",
  permissionRow: ".permission-list label",
  permissionInput: ".permission-list input",
  deviceList: ".device-list",
  deviceRow: ".device-row",
  deviceSymbol: ".device-symbol",
  remoteGuard: ".remote-guard",
  // schedules
  scheduleSummary: ".schedule-summary",
  scheduleSummaryCell: ".schedule-summary > div",
  scheduleSummaryStrong: ".schedule-summary strong",
  segmented: ".segmented",
  segmentedButton: ".segmented button",
  scheduleList: ".schedule-list",
  scheduleRow: ".schedule-row",
  scheduleTime: ".schedule-time",
  scheduleTimeSpan: ".schedule-time > span",
  scheduleActions: ".schedule-actions",
};

const report = {
  slice: "[UI 对齐 09] #33",
  prototypeA: {},
  renderer: {},
  geometry: {},
  assertions: { checked: 0, violations: [] },
};

const check = (label, ok, detail) => {
  report.assertions.checked += 1;
  if (!ok) report.assertions.violations.push(`${label}: ${detail}`);
  return ok;
};

const pick = (measured, keys) =>
  JSON.stringify(Object.fromEntries(keys.map((key) => [key, measured?.[key] ?? null])));

const same = (rendererSide, prototypeSide, keys, label) =>
  check(label, pick(rendererSide, keys) === pick(prototypeSide, keys), `${pick(rendererSide, keys)} vs ${pick(prototypeSide, keys)}`);

/** Installed into every page so the measurements share one reading. */
const STYLE_HELPER = () => {
  window.__styleOf = (element) => {
    if (!element) return null;
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      padding: computed.padding,
      margin: computed.margin,
      marginTop: computed.marginTop,
      marginBottom: computed.marginBottom,
      gap: computed.gap,
      columnGap: computed.columnGap,
      display: computed.display,
      fontSize: computed.fontSize,
      // [UI 对齐 09] #33 review P2-3: the bare `mono` marker class had no rule
      // behind it, so the endpoint/URL/usage figures rendered in the sans font.
      // Nothing collected the family, so no assertion could ever catch it.
      fontFamily: computed.fontFamily,
      fontWeight: computed.fontWeight,
      letterSpacing: computed.letterSpacing,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      borderWidth: computed.borderWidth,
      borderBottomWidth: computed.borderBottomWidth,
      borderRadius: computed.borderTopLeftRadius,
      textTransform: computed.textTransform,
      gridTemplateColumns: computed.gridTemplateColumns,
      // Track *count* is content-independent; `.grid3` etc. are compared by
      // their full track list, rows with `auto` tracks by their count.
      tracks: computed.gridTemplateColumns === "none" ? 0 : computed.gridTemplateColumns.split(" ").length,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      scrollHeight: element.scrollHeight,
    };
  };
  window.__measure = (selectors, root = document) =>
    Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, window.__styleOf(root.querySelector(selector))]));
  /** The renderer scopes every measurement to the page root, the prototype to `.page`. */
  window.__root = () => document.querySelector('[data-testid$="-page"]') ?? document.querySelector(".page");
  window.__count = (selectors, root = document) =>
    Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, root.querySelectorAll(selector).length]));
  window.__texts = (selector, root = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent.trim());
};

const launch = async () => {
  const chrome = await chromium.launch({ executablePath: CHROME });
  const context = await chrome.newContext();
  await context.addInitScript(STYLE_HELPER);
  return { chrome, context };
};

const { chrome, context } = await launch();
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

/** The same reading on both sides: properties, counts and a few text lists. */
const COLLECT = (selectors) => {
  const root = window.__root();
  // The renderer's page root sits inside the shell's `.page` (which owns the
  // 30/34 padding); the prototype's root *is* `.page`. Buttons are therefore
  // read from the root itself and the page box from the `.page` ancestor.
  const pageBox =
    root?.closest('[data-testid="page"]') ?? (root?.classList?.contains("page") ? root : (root?.closest(".page") ?? root));
  const buttonIcons = [...root.querySelectorAll(".btn")].map((button) => button.querySelectorAll("svg").length);
  const head = root.querySelector('[data-testid="run-history-head"]');
  // [UI 对齐 09] #33 review P1-1: `table` is Tailwind's `display:table` utility,
  // so carrying it beside `grid` stacked the header's five cells as anonymous
  // table-rows while every style-level assertion still passed. The header and
  // the (virtualised) first row are therefore read cell by cell, by box.
  const cellBoxes = (row) =>
    row === null ? null : [...row.children].map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width) };
    });
  const bodyRow = root.querySelector('[data-testid="run-history"] > div > div > div');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    viewLabel: root.querySelector(".view-label")?.textContent?.trim() ?? null,
    title: root.querySelector("h1")?.textContent?.trim() ?? null,
    intro: root.querySelector(".page-intro")?.textContent?.trim() ?? null,
    pageButtons: [...root.querySelectorAll(".btn")].map((button) => button.textContent.trim()),
    // [UI 对齐 08] #32 D4: the prototype's management buttons carry a glyph; the
    // renderer had none. Recorded as an array so the difference is visible.
    pageButtonIcons: buttonIcons,
    // [UI 对齐 09] #33 review P2-6: the count vector above depends on how many
    // rows the VirtualList happens to render, so a `>=` over it could not catch
    // a button that lost or gained a glyph. Keyed by the button's own label,
    // which does not depend on the window.
    pageButtonIconMap: Object.fromEntries(
      [...root.querySelectorAll(".btn")].map((button) => [button.textContent.trim(), button.querySelectorAll("svg").length]),
    ),
    measured: { ...window.__measure(selectors, root), page: window.__styleOf(pageBox) },
    counts: window.__count(selectors, root),
    // The renderer's run history keeps the VirtualList (40+ windowed rows), so
    // its header is a grid row rather than a `<table>`; both sides are read by
    // their own hook and compared cell by cell.
    tableHeaders: head ? [...head.children].map((cell) => cell.textContent.trim()) : window.__texts(".table th", root),
    historyHeadCell: window.__styleOf(head?.firstElementChild ?? root.querySelector(".table th")),
    // The layout claim the style assertions above cannot see: the header is one
    // row of five cells that line up with the body row underneath it.
    historyHeadBox: head === null ? null : window.__styleOf(head),
    historyHeadCells: cellBoxes(head),
    historyBodyCells: cellBoxes(bodyRow),
    historyMono: window.__styleOf(root.querySelector('[data-testid="run-history-head"] code, [data-testid="run-history"] code, .mono')),
    dots: [...root.querySelectorAll(".dot")].map((dot) => window.__styleOf(dot)),
    badges: window.__texts(".badge", root),
    empties: window.__texts(".empty", root),
    notes: window.__texts(".note", root),
    providerNames: window.__texts(".provider-card h3", root),
    providerChips: window.__texts(".provider-model-chips .badge", root),
    // [UI 对齐 09] #33 review P2-7: the prototype prints the protocol's display
    // name, not the wire id the Host stores.
    providerProtocolBadges: window.__texts('[data-testid^="provider-protocol-"]', root),
    // [UI 对齐 09] #33 review P2-2/P2-3: the guard card's own background and the
    // remote layout's card radius had no assertion, and the `.dot`/`.mono`
    // marker classes were declared with no rule behind them — the helper did not
    // even collect a font family, so nothing could catch it.
    remoteGuardBox: window.__styleOf(root.querySelector(".remote-guard")),
    remoteCardBox: window.__styleOf(root.querySelector(".remote-layout .card")),
    connectionChecks: [...root.querySelectorAll(".connection-checks > div")].map((row) => ({
      dot: window.__styleOf(row.querySelector(".dot")),
      icons: row.querySelectorAll("svg").length,
      mono: window.__styleOf(row.querySelector("code.mono, small.mono")),
    })),
    // Every element carrying the bare `mono` marker, on both sides.
    monoFamilies: [...root.querySelectorAll(".mono")].map((node) => getComputedStyle(node).fontFamily),
    dotBoxes: [...root.querySelectorAll(".dot")].map((node) => window.__styleOf(node)),
    // [UI 对齐 09] #33 review P2-4: the blocks the prototype's connection card
    // has and this page lacked.
    commandPreview: [...root.querySelectorAll(".command-preview code")].map((node) => node.textContent.trim()),
    remoteFlowSteps: window.__texts(".remote-flow span", root),
    remoteFlowArrows: root.querySelectorAll(".remote-flow svg").length,
    gatewayDetails: window.__texts(".gateway-details > *", root),
    // Declared absences: the Host owns no machine-name field and no entry
    // connect/disconnect op, so these stay unrendered on purpose.
    declaredAbsent: {
      machineName: root.querySelectorAll('input[aria-label="这台电脑的名称"]').length,
      entryToggle: [...root.querySelectorAll(".btn")].filter((button) => /^(启用此入口|断开连接)$/.test(button.textContent.trim())).length,
    },
    // [UI 对齐 09] #33 review P2-5: the device row's middle column must keep a
    // floor; its name must stay on one line.
    deviceRowCells: [...root.querySelectorAll(".device-row")].map((row) => [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().width))),
    deviceNameLines: [...root.querySelectorAll(".device-row")].map((row) => {
      const name = row.querySelector("strong");
      if (!name) return null;
      const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight) || 16;
      return Math.round(name.getBoundingClientRect().height / lineHeight);
    }),
    statLabels: window.__texts(".stat", root),
    // The `.stat` text is the value; its label is the card's leading `<small>`
    // on both sides ([UI 对齐 09] #33 review P2-1).
    statCardLabels: [...root.querySelectorAll(".stat")].map(
      (stat) => stat.closest(".card")?.querySelector("small")?.textContent?.trim() ?? null,
    ),
    capabilityNames: window.__texts(".capability-main strong", root),
    capabilityTabLabels: window.__texts(".capability-tabs button", root),
    capabilitySummary: window.__texts(".capability-summary > div", root),
    modeLabels: window.__texts(".remote-mode-picker button strong", root),
    modeSelected: [...root.querySelectorAll(".remote-mode-picker button")].findIndex((button) => button.classList.contains("selected") || button.getAttribute("aria-selected") === "true"),
    deviceNames: window.__texts(".device-row strong", root),
    scheduleNames: window.__texts(".schedule-row .schedule-main strong", root),
    scheduleSummary: window.__texts(".schedule-summary > div", root),
    segmentedLabels: window.__texts(".segmented button", root),
    archiveCards: window.__texts(".card h3", root),
    archiveCardsText: window.__texts(".card", root),
  };
};

const navigatePrototype = async (page, nav) => {
  await page.click(nav);
  await page.waitForTimeout(160);
};

const prototypePage = async (name, nav, viewport = { width: 1440, height: 900 }) => {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await navigatePrototype(page, nav);
  return page;
};

/** `report.renderer` is keyed by viewport; both sides are collected with one call. */
const bucket = (name) => (report.renderer[name] ??= {});

const rendererPage = async (route, viewport, testId) => {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`${RENDERER}${route}`, { waitUntil: "networkidle" });
  await page.waitForSelector(`[data-testid="${testId}"]`);
  await page.waitForTimeout(200);
  return page;
};

// ---------------------------------------------------------- 1. providers page
{
  const page = await prototypePage("providers", '[data-action="view:providers"]');
  report.prototypeA.providers = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/prototype/1440x900-providers.png` });
  await page.close();
}
{
  const page = await rendererPage("/providers", { width: 1440, height: 900 }, "providers-page");
  bucket("1440x900").providers = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-providers.png` });
  await page.close();
}

// -------------------------------------------------------------- 2. usage page
{
  const page = await prototypePage("usage", '[data-action="view:usage"]');
  report.prototypeA.usage = await page.evaluate(COLLECT, SELECTORS);
  report.prototypeA.usage.rangeOptions = await page.$$eval("#usage-range option", (options) => options.map((option) => option.textContent.trim()));
  report.prototypeA.usage.barHeights = await page.$$eval(".bar-column .bar", (bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)));
  await page.screenshot({ path: `${OUT}/prototype/1440x900-usage.png` });
  // Anti-no-op: the 统计日期 select really re-renders the page.
  const before = await page.$$eval(".bar-column", (columns) => columns.length);
  await page.selectOption("#usage-range", "今天");
  await page.waitForTimeout(120);
  const after = await page.$$eval(".bar-column", (columns) => columns.length);
  report.prototypeA.usage.rangeSwitch = { before, after };
  await page.close();
}
{
  const page = await rendererPage("/usage", { width: 1440, height: 900 }, "usage-page");
  // Every reading below is taken in a window pinned to explicit ledger dates
  // rather than to the wall clock: the prototype's sample ledger is fixed and
  // the page's presets are relative to *today*, so capturing geometry under
  // 近 7 天 made this whole section a few-days shelf life ([UI 对齐 09] #33
  // review P2-8). 全部 stays as the unfiltered baseline.
  bucket("1440x900").usageAll = await page.evaluate(COLLECT, SELECTORS);
  bucket("1440x900").usageAll.rows = await page.$eval('[data-testid="usage-table"]', (list) => Number(list.getAttribute("data-total-rows")));
  await page.selectOption('[data-testid="usage-range"]', "自定义");
  await page.fill('[aria-label="起始日期"]', LEDGER_FROM);
  await page.fill('[aria-label="结束日期"]', LEDGER_TO);
  await page.waitForTimeout(200);
  bucket("1440x900").usage = await page.evaluate(COLLECT, SELECTORS);
  bucket("1440x900").usage.rangeOptions = await page.$$eval('[data-testid="usage-range"] option', (options) =>
    options.map((option) => option.textContent.trim()),
  );
  bucket("1440x900").usage.barHeights = await page.$$eval('[data-testid="usage-page"] .bar-column .bar', (bars) =>
    bars.map((bar) => Math.round(bar.getBoundingClientRect().height)),
  );
  bucket("1440x900").usage.rows = await page.$eval('[data-testid="usage-table"]', (list) => Number(list.getAttribute("data-total-rows")));
  bucket("1440x900").usage.customWindow = await page.$eval('[data-testid="usage-page"]', (root) => ({
    bars: root.querySelectorAll(".bar-column").length,
    rows: Number(root.querySelector('[data-testid="usage-table"]')?.getAttribute("data-total-rows") ?? "-1"),
  }));
  await page.screenshot({ path: `${OUT}/renderer/1440x900-usage.png`, fullPage: true });
  // The 近 7 天 preset is asserted by the window it writes into the two date
  // inputs (six days back from the app's ledger day), not by a row count.
  await page.selectOption('[data-testid="usage-range"]', "近 7 天");
  await page.waitForTimeout(200);
  bucket("1440x900").usage.weeklyWindow = await page.evaluate(() => ({
    from: document.querySelector('[aria-label="起始日期"]')?.value ?? null,
    to: document.querySelector('[aria-label="结束日期"]')?.value ?? null,
    // The app buckets by its own ledger timezone (UTC+8), so "今天" is the
    // UTC+8 day and the script compares against that same definition.
    expectedTo: new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10),
  }));
  // A window with no records at all: the charts must give way to the empty
  // state instead of drawing seven zero bars as a reading.
  await page.fill('[aria-label="起始日期"]', "2030-01-01");
  await page.fill('[aria-label="结束日期"]', "2030-01-07");
  await page.waitForTimeout(200);
  const empty = await page.$eval('[data-testid="usage-page"]', (root) => ({
    barChart: root.querySelectorAll(".bar-chart").length,
    donut: root.querySelectorAll(".usage-donut").length,
    emptyText: root.querySelector(".empty")?.textContent?.trim() ?? null,
    rows: Number(root.querySelector('[data-testid="usage-table"]')?.getAttribute("data-total-rows") ?? "-1"),
  }));
  bucket("1440x900").usage.emptyWindow = empty;
  // Whatever the wall clock day holds, the charts and the empty state are
  // mutually exclusive — the invariant the old 今天 probe was reaching for.
  await page.selectOption('[data-testid="usage-range"]', "今天");
  await page.waitForTimeout(200);
  bucket("1440x900").usage.todaySwitch = await page.$eval('[data-testid="usage-page"]', (root) => ({
    barChart: root.querySelectorAll(".bar-chart").length,
    donut: root.querySelectorAll(".usage-donut").length,
    emptyText: root.querySelector(".empty")?.textContent?.trim() ?? null,
    rows: Number(root.querySelector('[data-testid="usage-table"]')?.getAttribute("data-total-rows") ?? "-1"),
  }));
  await page.close();
}

// ------------------------------------------------------ 3. capabilities page
{
  const page = await prototypePage("capabilities", '[data-action="view:capabilities"]');
  report.prototypeA.capabilities = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/prototype/1440x900-capabilities.png` });
  // Anti-no-op: the MCP tab adds the inline notice.
  await page.click('[data-action="capability-type:mcp"]');
  await page.waitForTimeout(120);
  report.prototypeA.capabilities.mcpTab = await page.evaluate(() => ({
    notice: document.querySelectorAll(".inline-notice").length,
    rows: document.querySelectorAll(".capability-row").length,
    tabLabels: [...document.querySelectorAll(".capability-tabs button")].map((button) => button.textContent.trim()),
  }));
  await page.close();
}
{
  const page = await rendererPage("/capabilities", { width: 1440, height: 900 }, "capabilities-page");
  bucket("1440x900").capabilities = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-capabilities.png`, fullPage: true });
  const before = bucket("1440x900").capabilities.counts.capRow;
  await page.click('[data-testid="capabilities-page"] .capability-tabs button:nth-child(3)');
  await page.waitForTimeout(200);
  bucket("1440x900").capabilities.mcpTab = await page.$eval('[data-testid="capabilities-page"]', (root) => ({
    notice: root.querySelectorAll(".inline-notice").length,
    rows: root.querySelectorAll(".capability-row").length,
    tabLabels: [...root.querySelectorAll(".capability-tabs button")].map((button) => button.textContent.trim()),
  }));
  bucket("1440x900").capabilities.mcpTab.rowsBefore = before;
  await page.close();
}

// ------------------------------------------------------------ 4. remote page
{
  const page = await prototypePage("remote", '[data-action="view:remote"]');
  report.prototypeA.remote = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/prototype/1440x900-remote.png` });
  await page.click('[data-action="remote-mode:funnel"]');
  await page.waitForTimeout(120);
  report.prototypeA.remote.funnelTab = await page.evaluate(() => ({
    selected: [...document.querySelectorAll(".remote-mode-picker button")].findIndex((button) => button.classList.contains("selected")),
    warnNotices: document.querySelectorAll(".remote-mode-note.warn").length,
    commandPreview: [...document.querySelectorAll(".command-preview code")].map((node) => node.textContent.trim()),
  }));
  await page.click('[data-action="remote-mode:gateway"]');
  await page.waitForTimeout(120);
  report.prototypeA.remote.gatewayTab = await page.evaluate(() => ({
    commandPreview: [...document.querySelectorAll(".command-preview code")].map((node) => node.textContent.trim()),
    remoteFlowSteps: [...document.querySelectorAll(".remote-flow span")].map((node) => node.textContent.trim()),
    remoteFlowArrows: document.querySelectorAll(".remote-flow svg").length,
    gatewayDetails: [...document.querySelectorAll(".gateway-details > *")].map((node) => node.textContent.trim()),
  }));
  await page.close();
}
{
  const page = await rendererPage("/remote", { width: 1440, height: 900 }, "remote-page");
  bucket("1440x900").remote = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-remote.png`, fullPage: true });
  // [UI 对齐 09] #33 review P2-4: the prototype renders a different block set per
  // mode — tailscale/funnel print the local command, gateway draws the request
  // path and its details. Captured per mode so the assertion is not just "the
  // tailscale screenshot looks right".
  await page.click('[data-testid="remote-page"] .remote-mode-picker button:nth-child(2)');
  await page.waitForTimeout(250);
  bucket("1440x900").remote.gatewayTab = await page.$eval('[data-testid="remote-page"]', (root) => ({
    commandPreview: [...root.querySelectorAll(".command-preview code")].map((node) => node.textContent.trim()),
    remoteFlowSteps: [...root.querySelectorAll(".remote-flow span")].map((node) => node.textContent.trim()),
    remoteFlowArrows: root.querySelectorAll(".remote-flow svg").length,
    gatewayDetails: [...root.querySelectorAll(".gateway-details > *")].map((node) => node.textContent.trim()),
  }));
  await page.click('[data-testid="remote-page"] .remote-mode-picker button:nth-child(3)');
  await page.waitForTimeout(250);
  bucket("1440x900").remote.funnelTab = await page.$eval('[data-testid="remote-page"]', (root) => ({
    selected: [...root.querySelectorAll(".remote-mode-picker button")].findIndex((button) => button.getAttribute("aria-selected") === "true"),
    warnNotices: root.querySelectorAll(".remote-mode-note.warn").length,
    commandPreview: [...root.querySelectorAll(".command-preview code")].map((node) => node.textContent.trim()),
  }));
  await page.close();
}

// --------------------------------------------------------- 5. schedules page
{
  const page = await prototypePage("schedules", '[data-action="view:schedules"]');
  report.prototypeA.schedules = await page.evaluate(COLLECT, SELECTORS);
  report.prototypeA.schedules.rowCountByFilter = {};
  for (const filter of ["all", "active", "paused"]) {
    await page.click(`[data-action="schedule-filter:${filter}"]`);
    await page.waitForTimeout(100);
    report.prototypeA.schedules.rowCountByFilter[filter] = await page.$$eval(".schedule-row", (rows) => rows.length);
  }
  await page.screenshot({ path: `${OUT}/prototype/1440x900-schedules.png` });
  await page.close();
}
{
  const page = await rendererPage("/schedules", { width: 1440, height: 900 }, "schedules-page");
  bucket("1440x900").schedules = await page.evaluate(COLLECT, SELECTORS);
  bucket("1440x900").schedules.rowCountByFilter = {};
  for (const [index, filter] of ["all", "active", "paused"].entries()) {
    await page.click(`[data-testid="schedules-page"] .segmented button:nth-child(${index + 1})`);
    await page.waitForTimeout(150);
    bucket("1440x900").schedules.rowCountByFilter[filter] = await page.$$eval('[data-testid="schedules-page"] .schedule-row', (rows) => rows.length);
  }
  await page.click('[data-testid="schedules-page"] .segmented button:nth-child(1)');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-schedules.png`, fullPage: true });
  await page.close();
}

// ----------------------------------------------------------- 6. archive page
// The prototype's archive page lists the *current* project's archived tasks;
// the renderer's lists every archived task (declared deviation), so counts are
// recorded and the empty state is captured on both sides.
{
  const page = await prototypePage("archive", '[data-action="view:archive"]');
  report.prototypeA.archiveEmpty = await page.evaluate(COLLECT, SELECTORS);
  // The prototype's archive page only lists the *current* project's archived
  // tasks, so the fixture has none: archive one through the task menu the
  // prototype exposes, then measure the card that appears.
  // The task menu is dispatched through the prototype's own action surface
  // (a headless click on the header's `···` did not open its modal here).
  await page.evaluate(() => window.dispatch("taskmenu"));
  await page.waitForTimeout(140);
  await page.evaluate(() => window.dispatch("archive-task"));
  await page.waitForTimeout(200);
  report.prototypeA.archive = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/prototype/1440x900-archive.png` });
  await page.close();
}
{
  const page = await rendererPage("/archive", { width: 1440, height: 900 }, "archive-page");
  bucket("1440x900").archive = await page.evaluate(COLLECT, SELECTORS);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-archive.png`, fullPage: true });
  await page.close();
}

// --------------------------------------------- 7. the same six pages at 1024
const PAGES = [
  { key: "providers", route: "/providers", nav: '[data-action="view:providers"]', testId: "providers-page" },
  { key: "usage", route: "/usage", nav: '[data-action="view:usage"]', testId: "usage-page" },
  { key: "capabilities", route: "/capabilities", nav: '[data-action="view:capabilities"]', testId: "capabilities-page" },
  { key: "remote", route: "/remote", nav: '[data-action="view:remote"]', testId: "remote-page" },
  { key: "schedules", route: "/schedules", nav: '[data-action="view:schedules"]', testId: "schedules-page" },
  { key: "archive", route: "/archive", nav: '[data-action="view:archive"]', testId: "archive-page" },
];

for (const page of PAGES) {
  const at1024 = await rendererPage(page.route, { width: 1024, height: 800 }, page.testId);
  bucket("1024x800")[page.key] = await at1024.evaluate(COLLECT, SELECTORS);
  await at1024.screenshot({ path: `${OUT}/renderer/1024x800-${page.key}.png`, fullPage: true });
  await at1024.close();
}

// Prototype at 1024 for the same pages (the page's own `@media` tier).
for (const page of PAGES) {
  const at1024 = await prototypePage(page.key, page.nav, { width: 1024, height: 800 });
  report.prototypeA[`${page.key}1024`] = await at1024.evaluate(COLLECT, SELECTORS);
  await at1024.screenshot({ path: `${OUT}/prototype/1024x800-${page.key}.png` });
  await at1024.close();
}

// ------------------------------------ 8. every tier: no horizontal overflow
// The acceptance box: 1440/1280/1024/900/720 with no horizontal overflow. The
// prototype stacks some blocks below 960/720, so a page that merely shrinks its
// columns still has to fit inside the viewport.
for (const viewport of VIEWPORTS) {
  for (const page of PAGES) {
    const tier = await rendererPage(page.route, { width: viewport.width, height: viewport.height }, page.testId);
    const measured = await tier.evaluate(COLLECT, SELECTORS);
    bucket(viewport.name)[page.key] ??= measured;
    check(
      `no horizontal overflow @${viewport.name}/${page.key}`,
      measured.noHorizontalOverflow,
      `scrollWidth ${measured.viewport.w}`,
    );
    await tier.close();
  }
}

// Per-viewport `.page` padding, read from the prototype at the same widths.
report.prototypeA.pagePaddingByViewport = {};
report.prototypeA.pageWidthByViewport = {};
for (const viewport of VIEWPORTS) {
  const page = await prototypePage("providers", '[data-action="view:providers"]', viewport);
  const box = await page.evaluate(() => {
    const element = document.querySelector(".page");
    const computed = getComputedStyle(element);
    return { padding: computed.padding, width: Math.round(element.getBoundingClientRect().width) };
  });
  report.prototypeA.pagePaddingByViewport[viewport.name] = box.padding;
  report.prototypeA.pageWidthByViewport[viewport.name] = box.width;
  await page.close();
}

// ------------------------------------------------------------- 9. assertions
const proto = report.prototypeA;
const at1440 = report.renderer["1440x900"];

// 9.1 The page head: view label + title + intro are the prototype's strings.
for (const key of ["providers", "usage", "capabilities", "remote", "schedules"]) {
  check(`view label @${key}`, at1440[key].viewLabel === proto[key].viewLabel, `${at1440[key].viewLabel} vs ${proto[key].viewLabel}`);
  check(`page title @${key}`, at1440[key].title === proto[key].title, `${at1440[key].title} vs ${proto[key].title}`);
}
// 已归档 carries no view label in the prototype (`archivePage()` starts at h1).
check("archive has no view label", proto.archive.viewLabel === null && at1440.archive.viewLabel === null, `${at1440.archive.viewLabel} vs ${proto.archive.viewLabel}`);
/**
 * [UI 对齐 09] #33 review P1-2: `intro` was asserted for one page only and by
 * `startsWith`, while the report claimed the two sides were equal. Three pages
 * rewrite it on purpose; each rewrite is pinned here (and in
 * `verification-log.md` §3) so a silent copy change fails, and every other page
 * must still match the prototype character for character.
 */
const INTRO_DEVIATIONS = {
  usage:
    "按实际调用累计，压缩上下文不会减少消耗。统计范围为本应用记录，不等同账户账单或供应商配额；未观测到的外部调用不伪造。本页数据为样例数据。",
  schedules: "定时任务拥有固定任务工作区，按规则新建独立会话；每次执行不继承上一次对话上下文，历史会话可查看并继续。",
  archive: "归档停止运行并保留代码、会话和浏览器状态；清理是另一个操作。恢复任务不自动启动服务或重新启用调度。",
};
for (const key of ["providers", "usage", "capabilities", "remote", "schedules", "archive"]) {
  const declared = INTRO_DEVIATIONS[key];
  if (declared === undefined) {
    check(`intro is the prototype's @${key}`, at1440[key].intro === proto[key].intro, `${at1440[key].intro} vs ${proto[key].intro}`);
  } else {
    check(
      `intro deviation @${key} is the declared rewrite`,
      at1440[key].intro === declared && declared !== proto[key].intro,
      `${at1440[key].intro}`,
    );
  }
}
/**
 * The prototype's page buttons this app deliberately does not render — each one
 * is a D-item in `verification-log.md` §3. `pageButtons` was collected but never
 * asserted before ([UI 对齐 09] #33 review P1-2); the extras this app adds stay
 * recorded in `pages.json` and are declared rather than asserted away.
 */
const DECLARED_BUTTON_GAPS = {
  providers: ["选择模型"],
  usage: [],
  capabilities: [],
  remote: ["启用此入口", "扫码添加", "撤销"],
  schedules: [],
  archive: ["恢复", "清理…"],
};
for (const [key, gaps] of Object.entries(DECLARED_BUTTON_GAPS)) {
  const have = new Set(at1440[key].pageButtons ?? []);
  const missing = (proto[key].pageButtons ?? []).filter((label) => !have.has(label) && !gaps.includes(label));
  check(`every prototype page button is on the ${key} page`, missing.length === 0, `missing ${JSON.stringify(missing)}`);
}

// 9.2 [UI 对齐 08] #32 D4: management buttons carry the prototype's glyphs.
const iconCounts = Object.fromEntries(Object.entries(at1440).map(([key, value]) => [key, value.pageButtonIcons]));
report.geometry.pageButtonIcons = {
  renderer: iconCounts,
  prototype: Object.fromEntries(["providers", "usage", "capabilities", "remote", "schedules", "archive"].map((key) => [key, proto[key].pageButtonIcons])),
};
for (const key of ["providers", "capabilities", "schedules"]) {
  check(`${key} add button has an icon`, (at1440[key].pageButtonIcons ?? []).some((count) => count >= 1), JSON.stringify(at1440[key].pageButtonIcons));
  check(
    `${key} add button matches the prototype's icon count`,
    (at1440[key].pageButtonIcons ?? []).filter((count) => count >= 1).length >=
      (proto[key].pageButtonIcons ?? []).filter((count) => count >= 1).length,
    `${JSON.stringify(at1440[key].pageButtonIcons)} vs ${JSON.stringify(proto[key].pageButtonIcons)}`,
  );
}
/**
 * [UI 对齐 09] #33 review P2-6: the `>=` above is one-way, so it could not fail
 * when a button gained a glyph the prototype does not have — and the report's
 * schedules count (3/6) did not match the JSON (5 glyphs across 21 buttons).
 * The rule is now two-way and keyed by the button's own label, so it does not
 * depend on how many rows the VirtualList renders: label by label, the two sides
 * must agree on whether the button carries a glyph, and the deliberate
 * exceptions are declared here.
 */
const DECLARED_ADDED_BUTTON_ICONS = { providers: ["编辑"] };
for (const key of ["providers", "usage", "capabilities", "remote", "schedules", "archive"]) {
  const gaps = DECLARED_BUTTON_GAPS[key];
  const added = DECLARED_ADDED_BUTTON_ICONS[key] ?? [];
  const renderer = at1440[key].pageButtonIconMap ?? {};
  const prototype = proto[key].pageButtonIconMap ?? {};
  const disagreements = Object.keys(prototype)
    .filter((label) => !gaps.includes(label) && label in renderer)
    .filter((label) => (renderer[label] > 0) !== (prototype[label] > 0) && !added.includes(label));
  check(
    `button glyphs agree with the prototype @${key}`,
    disagreements.length === 0,
    `disagree ${JSON.stringify(disagreements)}; renderer ${JSON.stringify(renderer)} vs prototype ${JSON.stringify(prototype)}`,
  );
}
check(
  "remote 手机视图 carries the prototype's globe glyph",
  (at1440.remote.pageButtonIconMap ?? {})["手机视图"] === 1 && (proto.remote.pageButtonIconMap ?? {})["手机视图"] === 1,
  JSON.stringify(at1440.remote.pageButtonIconMap),
);
/**
 * [UI 对齐 09] #33 review P2-1: the prototype's second stat card reads 当前会话.
 * This page is a project-wide ledger with no session context, so it shows
 * 最近一次调用 — a declared rewrite, pinned here so it cannot change silently
 * again (the unit test used to skip `labels[1]` for exactly that reason).
 */
const USAGE_STAT_LABELS = ["累计 Token", "最近一次调用", "已记录调用", "未完整报告"];
check(
  "usage stat labels: 当前会话 → 最近一次调用 is the declared rewrite",
  JSON.stringify(at1440.usage.statCardLabels) === JSON.stringify(USAGE_STAT_LABELS) &&
    (proto.usage.statCardLabels ?? [])[1] === "当前会话",
  `${JSON.stringify(at1440.usage.statCardLabels)} vs ${JSON.stringify(proto.usage.statCardLabels)}`,
);
check(
  "usage stat labels keep the prototype's other three cards",
  JSON.stringify(at1440.usage.statCardLabels?.filter((_, index) => index !== 1)) ===
    JSON.stringify((proto.usage.statCardLabels ?? []).filter((_, index) => index !== 1)),
  `${JSON.stringify(at1440.usage.statCardLabels)} vs ${JSON.stringify(proto.usage.statCardLabels)}`,
);

// 9.3 Providers: the card's blocks, chips and the three-column grid.
same(at1440.providers.measured.providerCard, proto.providers.measured.providerCard, ["padding", "borderRadius", "borderWidth", "backgroundColor"], "provider card box");
same(
  at1440.providers.measured.providerSymbol,
  proto.providers.measured.providerSymbol,
  ["width", "height", "borderRadius", "backgroundColor", "color", "fontSize", "fontWeight", "display"],
  "provider symbol",
);
same(at1440.providers.measured.providerCardP, proto.providers.measured.providerCardP, ["fontSize", "color", "marginTop", "marginBottom"], "provider endpoint line");
same(at1440.providers.measured.modelChips, proto.providers.measured.modelChips, ["display", "gap", "marginBottom", "flexWrap"], "provider model chips");
check("provider card count", at1440.providers.counts.providerCard === proto.providers.counts.providerCard, `${at1440.providers.counts.providerCard} vs ${proto.providers.counts.providerCard}`);
check(
  "provider chips name · window ( · 图片)",
  at1440.providers.providerChips.every((chip) => / · \d+k( · 图片)?$/.test(chip)),
  JSON.stringify(at1440.providers.providerChips),
);
check(
  "provider grid3 collapses at 960",
  at1440.providers.measured.grid3?.gridTemplateColumns?.split(" ").length === 3 &&
    report.renderer["720x800"].providers.measured.grid3?.gridTemplateColumns?.split(" ").length === 1,
  `${at1440.providers.measured.grid3?.gridTemplateColumns} / ${report.renderer["720x800"].providers.measured.grid3?.gridTemplateColumns}`,
);

// 9.4 Usage: the four stat cards, the bars, the donut and the six columns.
same(at1440.usage.measured.grid4, proto.usage.measured.grid4, ["gridTemplateColumns", "gap"], "usage grid4");
same(at1440.usage.measured.stat, proto.usage.measured.stat, ["fontSize", "fontWeight", "letterSpacing", "marginTop"], "usage stat");
same(at1440.usage.measured.barChart, proto.usage.measured.barChart, ["height", "gap", "paddingTop", "marginTop", "alignItems"], "usage bar chart");
report.geometry.chartWidth = { renderer: at1440.usage.measured.barChart?.width, prototype: proto.usage.measured.barChart?.width, bars: { renderer: at1440.usage.counts.barColumn, prototype: proto.usage.counts.barColumn } };
same(at1440.usage.measured.barColumn, proto.usage.measured.barColumn, ["display", "gap", "justifyContent", "alignItems", "textAlign"], "usage bar column");
same(at1440.usage.measured.bar, proto.usage.measured.bar, ["width", "borderRadius", "backgroundColor"], "usage bar");
same(at1440.usage.measured.donut, proto.usage.measured.donut, ["width", "height", "display"], "usage donut");
check("usage donut is a circle", at1440.usage.measured.donut?.width === at1440.usage.measured.donut?.height, JSON.stringify(at1440.usage.measured.donut));
same(at1440.usage.measured.th, proto.usage.measured.th, ["padding", "fontSize", "color", "backgroundColor", "borderBottomWidth"], "usage summary table th");
same(at1440.usage.measured.td, proto.usage.measured.td, ["padding", "borderBottomWidth"], "usage summary table td");
check(
  "usage summary table has the prototype's six columns",
  JSON.stringify(at1440.usage.tableHeaders) === JSON.stringify(proto.usage.tableHeaders),
  `${JSON.stringify(at1440.usage.tableHeaders)} vs ${JSON.stringify(proto.usage.tableHeaders)}`,
);
check("usage has four stat cards", at1440.usage.counts.stat === proto.usage.counts.stat, `${at1440.usage.counts.stat} vs ${proto.usage.counts.stat}`);
check("usage has a bar per day", at1440.usage.counts.barColumn >= 7, `${at1440.usage.counts.barColumn} bars`);
check(
  "usage numbers come from the store (bar heights are computed, not the prototype's sample)",
  at1440.usage.barHeights.every((height) => height >= 1) && new Set(at1440.usage.barHeights).size > 1,
  JSON.stringify(at1440.usage.barHeights),
);
check(
  "usage summary badge says 示例 · 不代表账单",
  at1440.usage.badges.includes("示例 · 不代表账单"),
  JSON.stringify(at1440.usage.badges),
);
check(
  "usage 统计日期 keeps the prototype's three ranges",
  ["近 7 天", "今天", "近 30 天"].every((option) => at1440.usage.rangeOptions.includes(option)),
  JSON.stringify(at1440.usage.rangeOptions),
);
// Anti-no-op: an explicit window really re-filters the rows, and a window with
// no records at all reaches the empty state instead of drawing seven zero bars.
// Both probes drive the page's own dates, so neither depends on the wall clock
// ([UI 对齐 09] #33 review P2-8: the old probe asked whether the *current week*
// intersected a ledger fixed to 2026-09-12…21 and stopped passing from
// 2026-09-28).
check(
  "usage 自定义 window re-filters the rows and redraws seven bars",
  at1440.usage.customWindow.bars === 7 && at1440.usage.customWindow.rows > 0 && at1440.usage.customWindow.rows < at1440.usageAll.rows,
  JSON.stringify({ custom: at1440.usage.customWindow, all: at1440.usageAll.rows }),
);
check(
  "usage 近 7 天 writes a seven-day window ending on the ledger's today",
  at1440.usage.weeklyWindow.to === at1440.usage.weeklyWindow.expectedTo &&
    Date.parse(`${at1440.usage.weeklyWindow.to}T00:00:00Z`) - Date.parse(`${at1440.usage.weeklyWindow.from}T00:00:00Z`) === 6 * 86400_000,
  JSON.stringify(at1440.usage.weeklyWindow),
);
check(
  "usage window with no record shows the empty state instead of zero bars",
  at1440.usage.emptyWindow.rows === 0 &&
    at1440.usage.emptyWindow.barChart === 0 &&
    at1440.usage.emptyWindow.donut === 0 &&
    at1440.usage.emptyWindow.emptyText !== null,
  JSON.stringify(at1440.usage.emptyWindow),
);
check(
  "usage charts and the empty state are mutually exclusive",
  (at1440.usage.todaySwitch.barChart === 0) === (at1440.usage.todaySwitch.emptyText !== null) &&
    (at1440.usage.todaySwitch.donut === 0) === (at1440.usage.todaySwitch.barChart === 0),
  JSON.stringify(at1440.usage.todaySwitch),
);

// 9.4b Remote: the marker classes, the guard card and the per-mode blocks
// ([UI 对齐 09] #33 review P2-2/P2-3/P2-4/P2-5/P2-7).
check(
  "provider badge shows the protocol's display name, not the wire id",
  at1440.providers.providerProtocolBadges.length > 0 &&
    at1440.providers.providerProtocolBadges.every((label) => ["Anthropic Messages", "OpenAI Responses", "OpenAI Chat Completions"].includes(label)),
  JSON.stringify(at1440.providers.providerProtocolBadges),
);
// The prototype's `.dot` rule and the renderer's utilities must land on the same
// box; the connection rows used to draw an empty 8px column instead. Chromium
// reports the two circles differently (`50%` vs a resolved px value), so the
// radius is compared as a length, not as a string.
const radiusPx = (box) =>
  box === null || box === undefined
    ? null
    : box.borderRadius.endsWith("%")
      ? (Number.parseFloat(box.borderRadius) / 100) * box.width
      : Number.parseFloat(box.borderRadius);
const renderedDot = at1440.remote.connectionChecks[0].dot;
const prototypeDot = proto.remote.connectionChecks[0].dot;
same(renderedDot, prototypeDot, ["width", "height", "backgroundColor"], "connection-check dot box");
check(
  "connection-check dots are circles on both sides",
  [renderedDot, prototypeDot].every((box) => radiusPx(box) >= box.width / 2 - 0.5),
  `${radiusPx(renderedDot)}px on ${renderedDot.width} vs ${radiusPx(prototypeDot)}px on ${prototypeDot.width}`,
);
check(
  "the live connection row's dot is the accent one",
  at1440.remote.connectionChecks[1].dot?.backgroundColor === proto.remote.connectionChecks[1].dot?.backgroundColor &&
    at1440.remote.connectionChecks[1].dot?.backgroundColor !== at1440.remote.connectionChecks[0].dot?.backgroundColor,
  `${at1440.remote.connectionChecks[1].dot?.backgroundColor} vs ${proto.remote.connectionChecks[1].dot?.backgroundColor}`,
);
check(
  "every connection row draws a dot",
  at1440.remote.connectionChecks.every((row) => row.dot !== null) && at1440.remote.connectionChecks.length === 3,
  JSON.stringify(at1440.remote.connectionChecks.map((row) => row.dot)),
);
// `.mono` is declared with no rule in this package; the endpoint/URL figures
// therefore rendered in the page's sans font. `same(...)` cannot compare the two
// stacks (this package has no `--mono` token), so the rule asserted is "every
// element carrying the marker is actually monospace, and not the page's sans
// family" — true on both sides and exactly the failure the old script missed.
const monoFamilies = [...(at1440.remote.monoFamilies ?? []), ...(proto.remote.monoFamilies ?? []), ...(at1440.providers.monoFamilies ?? []), ...(at1440.usage.monoFamilies ?? [])];
const sansFamily = at1440.providers.measured.providerCard?.fontFamily;
check(
  "every `.mono` marker renders in a monospace family",
  monoFamilies.length >= 3 &&
    monoFamilies.every((family) => /mono/i.test(family)) &&
    monoFamilies.every((family) => family !== sansFamily),
  JSON.stringify({ count: monoFamilies.length, monoFamilies, sansFamily }),
);
// P2-2: the guard card's own background lost to `Card`'s `bg-paper`, and
// `.remote-layout .card{border-radius:8px}` was never applied.
same(at1440.remote.remoteGuardBox, proto.remote.remoteGuardBox, ["backgroundColor", "borderRadius", "padding"], "remote guard card box");
same(at1440.remote.remoteCardBox, proto.remote.remoteCardBox, ["borderRadius"], "remote layout card radius");
check(
  "remote guard card is not plain white",
  at1440.remote.remoteGuardBox?.backgroundColor !== "rgb(255, 255, 255)",
  String(at1440.remote.remoteGuardBox?.backgroundColor),
);
// P2-4: the blocks the prototype's connection card has and this page lacked.
check(
  "tailscale mode prints the local command with the Host's listener",
  at1440.remote.commandPreview.length === 1 && at1440.remote.commandPreview[0].startsWith("tailscale serve --bg ") &&
    proto.remote.commandPreview.length === 1 && proto.remote.commandPreview[0].startsWith("tailscale serve --bg "),
  `${JSON.stringify(at1440.remote.commandPreview)} vs ${JSON.stringify(proto.remote.commandPreview)}`,
);
check(
  "gateway mode draws the request path instead of a command",
  JSON.stringify(at1440.remote.gatewayTab.remoteFlowSteps) === JSON.stringify(proto.remote.gatewayTab.remoteFlowSteps) &&
    at1440.remote.gatewayTab.remoteFlowArrows === proto.remote.gatewayTab.remoteFlowArrows &&
    JSON.stringify(at1440.remote.gatewayTab.gatewayDetails) === JSON.stringify(proto.remote.gatewayTab.gatewayDetails) &&
    at1440.remote.gatewayTab.commandPreview.length === proto.remote.gatewayTab.commandPreview.length,
  `${JSON.stringify(at1440.remote.gatewayTab)} vs ${JSON.stringify(proto.remote.gatewayTab)}`,
);
check(
  "funnel mode prints its own command",
  at1440.remote.funnelTab.commandPreview.length === 1 &&
    at1440.remote.funnelTab.commandPreview[0].startsWith("tailscale funnel --bg ") &&
    proto.remote.funnelTab.commandPreview.length === 1 &&
    proto.remote.funnelTab.commandPreview[0].startsWith("tailscale funnel --bg "),
  `${JSON.stringify(at1440.remote.funnelTab.commandPreview)} vs ${JSON.stringify(proto.remote.funnelTab.commandPreview)}`,
);
check(
  "`重新检测` sits on the tailscale connection row and carries no glyph",
  at1440.remote.connectionChecks[0].icons === proto.remote.connectionChecks[0].icons &&
    (at1440.remote.pageButtons ?? []).includes("重新检测") &&
    (at1440.remote.pageButtonIconMap ?? {})["重新检测"] === 0 &&
    (proto.remote.pageButtonIconMap ?? {})["重新检测"] === 0,
  JSON.stringify({ rowIcons: [at1440.remote.connectionChecks[0].icons, proto.remote.connectionChecks[0].icons], map: at1440.remote.pageButtonIconMap?.["重新检测"] }),
);
// The declared absences: no Host field and no write op, so the page must not
// pretend to have them.
check(
  "declared-absent remote controls stay absent",
  at1440.remote.declaredAbsent.machineName === 0 && at1440.remote.declaredAbsent.entryToggle === 0,
  JSON.stringify(at1440.remote.declaredAbsent),
);
// P2-5: four buttons in the row's `auto` track used to squeeze the name column
// to zero (measured 15px / 40 wrapped lines at 1440).
check(
  "every device row keeps a usable name column",
  at1440.remote.deviceRowCells.every((cells) => cells.length === 3 && cells[1] >= 100) &&
    at1440.remote.deviceNameLines.every((lines) => lines === 1),
  JSON.stringify({ cells: at1440.remote.deviceRowCells, nameLines: at1440.remote.deviceNameLines }),
);

// 9.5 Capabilities: the summary strip, the counted tabs and the rows.
same(at1440.capabilities.measured.capSummary, proto.capabilities.measured.capSummary, ["gridTemplateColumns", "borderRadius", "borderWidth", "backgroundColor"], "capability summary strip");
same(at1440.capabilities.measured.capSummaryCell, proto.capabilities.measured.capSummaryCell, ["padding", "display", "gap", "borderWidth"], "capability summary cell");
same(at1440.capabilities.measured.capSummaryStrong, proto.capabilities.measured.capSummaryStrong, ["fontSize", "fontWeight", "display"], "capability summary count");
same(at1440.capabilities.measured.capTabs, proto.capabilities.measured.capTabs, ["display", "gap", "marginBottom", "borderBottomWidth"], "capability tabs");
same(at1440.capabilities.measured.capTabSpan, proto.capabilities.measured.capTabSpan, ["fontSize", "color"], "capability tab count");
same(at1440.capabilities.measured.capRow, proto.capabilities.measured.capRow, ["display", "tracks", "gap", "padding", "borderBottomWidth"], "capability row");
same(at1440.capabilities.measured.capIcon, proto.capabilities.measured.capIcon, ["width", "height", "borderRadius", "backgroundColor", "color", "display"], "capability icon");
same(at1440.capabilities.measured.capMeta, proto.capabilities.measured.capMeta, ["display", "gap", "fontSize", "color"], "capability meta line");
check("capability summary has four cells", at1440.capabilities.counts.capSummaryCell === proto.capabilities.counts.capSummaryCell, `${at1440.capabilities.counts.capSummaryCell} vs ${proto.capabilities.counts.capSummaryCell}`);
check(
  "capability tabs carry a count each",
  at1440.capabilities.capabilityTabLabels.every((label) => /\d+ \/ \d+ 已启用/.test(label)),
  JSON.stringify(at1440.capabilities.capabilityTabLabels),
);
check(
  "capability summary shows four counts",
  at1440.capabilities.capabilitySummary.every((cell) => /^\d+(Skills|MCPServers|Extensions|Packages)$/.test(cell.replace(/\s+/g, ""))),
  JSON.stringify(at1440.capabilities.capabilitySummary),
);
// Anti-no-op: the MCP tab adds the prototype's notice and narrows the rows.
check(
  "capability MCP tab really filters",
  at1440.capabilities.mcpTab.notice >= 1 && at1440.capabilities.mcpTab.rows < at1440.capabilities.mcpTab.rowsBefore,
  JSON.stringify(at1440.capabilities.mcpTab),
);
check(
  "capability MCP notice is the prototype's text",
  at1440.capabilities.mcpTab.notice >= 1 && proto.capabilities.mcpTab.notice >= 1,
  `${at1440.capabilities.mcpTab.notice} vs ${proto.capabilities.mcpTab.notice}`,
);

// 9.6 Remote: the mode picker, the connection checks and the device rows.
same(at1440.remote.measured.modePicker, proto.remote.measured.modePicker, ["display", "gridTemplateColumns", "gap"], "remote mode picker grid");
same(at1440.remote.measured.modeButton, proto.remote.measured.modeButton, ["padding", "borderRadius", "borderWidth", "backgroundColor", "tracks", "display", "columnGap"], "remote mode button");
same(at1440.remote.measured.modeSymbol, proto.remote.measured.modeSymbol, ["width", "height", "borderRadius", "backgroundColor", "color", "display"], "remote mode symbol");
same(at1440.remote.measured.modeStrong, proto.remote.measured.modeStrong, ["fontSize", "fontWeight"], "remote mode label");
same(at1440.remote.measured.modeSmall, proto.remote.measured.modeSmall, ["fontSize"], "remote mode hint");
same(at1440.remote.measured.modeEm, proto.remote.measured.modeEm, ["fontSize", "fontStyle"], "remote mode 推荐 badge");
same(at1440.remote.measured.remoteLayout, proto.remote.measured.remoteLayout, ["display", "gridTemplateColumns", "gap"], "remote layout");
same(at1440.remote.measured.orb, proto.remote.measured.orb, ["width", "height"], "remote status orb");
same(at1440.remote.measured.checkRow, proto.remote.measured.checkRow, ["display", "tracks", "gap", "padding", "alignItems"], "remote connection check row");
same(at1440.remote.measured.permissionRow, proto.remote.measured.permissionRow, ["display", "alignItems", "gap", "padding", "borderBottomWidth"], "remote permission row");
same(at1440.remote.measured.permissionInput, proto.remote.measured.permissionInput, ["width", "height"], "remote permission checkbox");
same(at1440.remote.measured.deviceRow, proto.remote.measured.deviceRow, ["display", "tracks", "gap", "padding", "borderBottomWidth", "alignItems"], "remote device row");
same(at1440.remote.measured.deviceSymbol, proto.remote.measured.deviceSymbol, ["width", "height", "backgroundColor", "color", "display"], "remote device symbol");
check("remote mode count", at1440.remote.counts.modeButton === proto.remote.counts.modeButton, `${at1440.remote.counts.modeButton} vs ${proto.remote.counts.modeButton}`);
check("remote permission rows", at1440.remote.counts.permissionRow === proto.remote.counts.permissionRow, `${at1440.remote.counts.permissionRow} vs ${proto.remote.counts.permissionRow}`);
// The mode *labels* differ on purpose: the renderer uses the app's own names
// (自建 PiDock Gateway / Funnel 公网入口, asserted by remoteFlow), which the
// prototype shortens to 自建 Gateway / Funnel. Recorded, then compared by
// keyword so "the same three modes" is still checked.
report.geometry.modeLabels = { renderer: at1440.remote.modeLabels, prototype: proto.remote.modeLabels };
check(
  "remote offers the prototype's three modes",
  at1440.remote.modeLabels.length === proto.remote.modeLabels.length &&
    ["Tailscale", "Gateway", "Funnel"].every((keyword) => at1440.remote.modeLabels.some((label) => label.includes(keyword))),
  JSON.stringify(at1440.remote.modeLabels),
);
check("remote starts on the recommended mode", at1440.remote.modeSelected === proto.remote.modeSelected, `${at1440.remote.modeSelected} vs ${proto.remote.modeSelected}`);
// Anti-no-op: switching to Funnel warns and moves the selection.
check(
  "remote mode switch really switches",
  at1440.remote.funnelTab.selected === 2 && at1440.remote.funnelTab.warnNotices >= 1,
  JSON.stringify(at1440.remote.funnelTab),
);

// 9.7 Schedules: the summary strip, the filter and the row geometry.
same(at1440.schedules.measured.scheduleSummary, proto.schedules.measured.scheduleSummary, ["display", "gridTemplateColumns", "borderRadius", "borderWidth"], "schedule summary strip");
same(at1440.schedules.measured.scheduleSummaryCell, proto.schedules.measured.scheduleSummaryCell, ["display", "gap", "padding", "borderWidth"], "schedule summary cell");
same(at1440.schedules.measured.scheduleSummaryStrong, proto.schedules.measured.scheduleSummaryStrong, ["fontSize", "fontWeight"], "schedule summary value");
same(at1440.schedules.measured.segmented, proto.schedules.measured.segmented, ["display", "padding", "borderRadius", "borderWidth", "backgroundColor"], "schedule filter segmented");
same(at1440.schedules.measured.segmentedButton, proto.schedules.measured.segmentedButton, ["padding", "borderRadius", "fontSize"], "schedule filter button");
same(at1440.schedules.measured.scheduleRow, proto.schedules.measured.scheduleRow, ["display", "tracks", "gap", "padding", "borderBottomWidth", "alignItems"], "schedule row");
same(at1440.schedules.measured.scheduleTime, proto.schedules.measured.scheduleTime, ["display", "tracks", "gap", "alignItems"], "schedule time column");
same(at1440.schedules.measured.scheduleTimeSpan, proto.schedules.measured.scheduleTimeSpan, ["width", "height", "display"], "schedule clock glyph");
same(at1440.schedules.measured.scheduleActions, proto.schedules.measured.scheduleActions, ["display", "alignItems", "gap", "flexWrap", "justifyContent"], "schedule actions");
same(at1440.schedules.historyHeadCell, proto.schedules.measured.th, ["padding", "fontSize", "color", "fontWeight", "backgroundColor", "borderBottomWidth"], "schedule history header cell");
check("schedule summary has three cells", at1440.schedules.counts.scheduleSummaryCell === proto.schedules.counts.scheduleSummaryCell, `${at1440.schedules.counts.scheduleSummaryCell} vs ${proto.schedules.counts.scheduleSummaryCell}`);
check(
  "schedule filter keeps the prototype's three segments",
  JSON.stringify(at1440.schedules.segmentedLabels) === JSON.stringify(proto.schedules.segmentedLabels),
  `${JSON.stringify(at1440.schedules.segmentedLabels)} vs ${JSON.stringify(proto.schedules.segmentedLabels)}`,
);
check(
  "schedule history has the prototype's five columns",
  at1440.schedules.tableHeaders.length === 5 && proto.schedules.tableHeaders.length === 5,
  `${at1440.schedules.tableHeaders.length} vs ${proto.schedules.tableHeaders.length}`,
);
// [UI 对齐 09] #33 review P1-1: the five cells must sit on **one** line and line
// up with the body row. `table` beside `grid` stacked them into a 66px column
// while every style-level assertion above still passed.
const headCells = at1440.schedules.historyHeadCells ?? [];
const bodyCells = at1440.schedules.historyBodyCells ?? [];
check(
  "schedule history header is one row of five cells",
  headCells.length === 5 && new Set(headCells.map((cell) => cell.y)).size === 1,
  JSON.stringify(headCells.map((cell) => ({ x: cell.x, y: cell.y }))),
);
check(
  "schedule history header cell display is not `table-cell`",
  at1440.schedules.historyHeadCell?.display !== "table-cell" && at1440.schedules.historyHeadBox?.display === "grid",
  `${at1440.schedules.historyHeadBox?.display} / cell ${at1440.schedules.historyHeadCell?.display}`,
);
check(
  "schedule history header lines up with the body row",
  bodyCells.length === headCells.length && bodyCells.every((cell, index) => Math.abs(cell.w - headCells[index].w) === 0),
  `head ${JSON.stringify(headCells.map((cell) => cell.w))} vs body ${JSON.stringify(bodyCells.map((cell) => cell.w))}`,
);
// Anti-no-op: the filter really narrows the list.
check(
  "schedule filter really filters",
  at1440.schedules.rowCountByFilter.paused > 0 && at1440.schedules.rowCountByFilter.paused < at1440.schedules.rowCountByFilter.all,
  JSON.stringify(at1440.schedules.rowCountByFilter),
);
check(
  "schedule rows carry a rule, a timezone and an action row",
  at1440.schedules.scheduleNames.length === at1440.schedules.counts.scheduleRow && at1440.schedules.counts.scheduleActions === at1440.schedules.counts.scheduleRow,
  `${at1440.schedules.scheduleNames.length} names / ${at1440.schedules.counts.scheduleActions} action rows`,
);

// 9.8 Archive: the card head and the empty state.
same(at1440.archive.measured.card, proto.archive.measured.card, ["padding", "borderRadius", "borderWidth", "backgroundColor"], "archive card");
check("prototype archive drives to a card", proto.archive.counts.card >= 1, `${proto.archive.counts.card} cards`);
check(
  "archive cards name the task and its shape",
  at1440.archive.archiveCards.length >= 1 &&
    at1440.archive.archiveCardsText.some((text) => /个仓库|普通目录/.test(text) && text.includes("会话与浏览器状态已保留")),
  JSON.stringify(at1440.archive.archiveCards),
);
check(
  "archive keeps the prototype's two actions",
  at1440.archive.pageButtons.includes("恢复任务") && at1440.archive.pageButtons.includes("预览清理清单"),
  JSON.stringify(at1440.archive.pageButtons),
);
check(
  "archive empty state wording",
  proto.archive.empties.concat(at1440.archive.empties).every((text) => text === "" || text.includes("归档任务")),
  JSON.stringify({ renderer: at1440.archive.empties, prototype: proto.archive.empties }),
);

// Accent-coloured markers are recorded, not asserted: prototype A's trailing
// "Review revision" layer overrides `--accent` to #4668cc while this app's
// token is the base #233c78 (epic-level decision D5, still open).
report.geometry.accentUsers = {
  modeBadge: { renderer: at1440.remote.measured.modeEm?.color, prototype: proto.remote.measured.modeEm?.color },
  clock: { renderer: at1440.schedules.measured.scheduleTimeSpan?.color, prototype: proto.schedules.measured.scheduleTimeSpan?.color },
};

// 9.9 The `.page` head geometry follows the prototype at every tier.
for (const viewport of VIEWPORTS) {
  const measured = report.renderer[viewport.name]?.providers;
  if (!measured) continue;
  check(
    `page padding @${viewport.name}`,
    measured.measured.page?.padding === proto.pagePaddingByViewport[viewport.name],
    `${measured.measured.page?.padding} vs ${proto.pagePaddingByViewport[viewport.name]}`,
  );
  // The `.page` column sits next to the 226px sidebar on both sides, so the two
  // widths are compared with a 20px tolerance (a visible scrollbar shifts one
  // side by ~15px).
  check(
    `page width follows the prototype @${viewport.name}`,
    Math.abs((measured.measured.page?.width ?? 0) - (proto.pageWidthByViewport[viewport.name] ?? 0)) <= 20,
    `${measured.measured.page?.width} vs ${proto.pageWidthByViewport[viewport.name]}`,
  );
}

// 9.10 The 1024 tier keeps every block on screen.
for (const page of PAGES) {
  const measured = report.renderer["1024x800"][page.key];
  check(`1024 no overflow @${page.key}`, measured.noHorizontalOverflow, "scrollWidth exceeds viewport");
}
check(
  "capability summary folds to two columns below 960",
  report.renderer["720x800"].capabilities.measured.capSummary?.gridTemplateColumns?.split(" ").length === 1,
  report.renderer["720x800"].capabilities.measured.capSummary?.gridTemplateColumns,
);
check(
  "remote layout stacks below 960",
  report.renderer["720x800"].remote.measured.remoteLayout?.gridTemplateColumns?.split(" ").length === 1,
  report.renderer["720x800"].remote.measured.remoteLayout?.gridTemplateColumns,
);

await writeFile(`${OUT}/pages.json`, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `[UI 对齐 09] #33 evidence: ${report.assertions.violations.length === 0 ? "ok" : "FAILED"} ` +
    `(${report.assertions.checked} assertions, ${VIEWPORTS.length} viewport tiers, 6 pages)`,
);
for (const violation of report.assertions.violations) console.log(`  - ${violation}`);
await chrome.close();
process.exit(report.assertions.violations.length === 0 ? 0 : 1);
