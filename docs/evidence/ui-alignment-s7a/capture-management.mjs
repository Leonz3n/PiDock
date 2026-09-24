// [UI 对齐 08] (#32) management-page evidence.
//
// jsdom has no layout, so this slice's claims are measured in headless
// Chromium: the `.page` shell, the `.card` / `.grid` / `.stat` block, the
// `.management-list` / `.check-row` rows, the `.table` used by 查看生效配置,
// and the `.modal` those dialogs live in — each compared with the same property
// read from prototype A in the same run, so "aligns with the prototype" is a
// measured equality rather than a comment. The management primitives carry the
// prototype's class as an unstyled marker (`card`, `stat`, `grid3`,
// `management-row`, …), which is what makes "the same selector on both sides"
// possible.
//
// The prototype picks its project page from the project itself
// (`managementProjectPage()` delegates to `directoryProjectPage()` once a
// project owns an ordinary directory), so both shapes are captured and driven:
// the repository shape as the prototype boots, the directory shape after adding
// a directory to the prototype's own project — and on our side Orbit API
// (no directories) versus Atlas Web (one directory).
//
//   node docs/evidence/ui-alignment-s7a/capture-management.mjs
//
// Images and JSON land next to this file. Every locator is a `data-testid` (the
// [UI 对齐 06] #30 lesson: an evidence script keyed on an accessible name
// breaks the moment a later slice aligns that name).

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

// The prototype's own tiers: `@media(max-width:960px){.page{padding:25px}}` and
// `@media(max-width:720px){.page{padding:20px}}`, so 1024 is still 30/34.
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
  { name: "900x800", width: 900, height: 800 },
  { name: "720x800", width: 720, height: 800 },
];

// The prototype's class names, read on both sides.
const MANAGEMENT_SELECTORS = {
  page: ".page",
  viewLabel: ".view-label",
  // The page's first `h2`. The prototype declares no `font-weight` on `h2`, so
  // its computed value is the browser's 700 (h1/h3 declare 650) — measured
  // against the renderer rather than asserted in a comment.
  sectionTitle: "h2",
  pageIntro: ".page-intro",
  card: ".card",
  stat: ".stat",
  grid2: ".grid2",
  grid3: ".grid3",
  checkRow: ".check-row",
  managementList: ".management-list",
  managementRow: ".management-row",
  note: ".note",
  empty: ".empty",
  inlineNotice: ".inline-notice",
  previewNote: ".preview-note",
  tableWrap: ".table-wrap",
  table: ".table",
  modal: ".modal",
  modalBody: ".modal-body",
};

const report = {
  slice: "[UI 对齐 08] #32",
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

/** Installed into every page so the measurements share one reading. */
const STYLE_HELPER = () => {
  window.__styleOf = (element) => {
    if (!element) return null;
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      padding: computed.padding,
      marginTop: computed.marginTop,
      marginBottom: computed.marginBottom,
      gap: computed.gap,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      letterSpacing: computed.letterSpacing,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      borderRadius: computed.borderTopLeftRadius,
      borderWidth: computed.borderWidth,
      textTransform: computed.textTransform,
      gridTemplateColumns: computed.gridTemplateColumns,
      overflowY: computed.overflowY,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  window.__measure = (selectors, root = document) =>
    Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => [name, window.__styleOf(root.querySelector(selector))]),
    );
};

const chrome = await chromium.launch({ executablePath: CHROME });
const context = await chrome.newContext();
await context.addInitScript(STYLE_HELPER);
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

/** Only the properties a button comparison needs. */
const styleOfShallow = (measured) =>
  measured
    ? {
        padding: measured.padding,
        fontSize: measured.fontSize,
        borderRadius: measured.borderRadius,
        gap: measured.gap,
      }
    : null;

const pick = (measured, keys) =>
  JSON.stringify(Object.fromEntries(keys.map((key) => [key, measured?.[key] ?? null])));

// -------------------------------------------------------- prototype reference
//
// The prototype boots into the task workspace, so the project page is reached
// through its own sidebar (`data-action="view:project"`), and the directory
// shape by adding an ordinary directory through 编辑项目 first.
let prototypePage = await context.newPage();
await prototypePage.setViewportSize({ width: 1440, height: 900 });
await prototypePage.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
await prototypePage.waitForTimeout(300);

// Repository shape: the prototype's boot state (its project owns no directory).
await prototypePage.click('[data-action="view:project"]');
await prototypePage.waitForTimeout(150);
report.prototypeA.repository = await prototypePage.evaluate((selectors) => {
  const measured = window.__measure(selectors);
  return {
    ...measured,
    heading: document.querySelector("h1")?.textContent?.trim() ?? null,
    statCount: document.querySelectorAll(".stat").length,
    checkRowCount: document.querySelectorAll(".check-row").length,
    taskCardMeta: [...document.querySelectorAll(".taskcard small")].map((s) => s.textContent.trim()),
    palette: (() => {
      const root = getComputedStyle(document.documentElement);
      return {
        accent: root.getPropertyValue("--accent").trim(),
        soft: root.getPropertyValue("--soft").trim(),
        sidebar: root.getPropertyValue("--sidebar").trim(),
        bg: root.getPropertyValue("--bg").trim(),
      };
    })(),
  };
}, MANAGEMENT_SELECTORS);
await prototypePage.screenshot({ path: `${OUT}/prototype/1440x900-project-repository.png` });

// The projects dialog (`projectsDialog()`).
await prototypePage.click('[data-action="projects"]');
await prototypePage.waitForTimeout(150);
report.prototypeA.projectsDialog = await prototypePage.evaluate((selectors) => ({
  ...window.__measure(selectors),
  rowCount: document.querySelectorAll(".modal .management-row").length,
  entries: [...document.querySelectorAll(".modal .management-row")].map((row) =>
    [...row.querySelectorAll("button")].map((button) => button.textContent.trim()),
  ),
  badges: [...document.querySelectorAll(".modal .badge")].length,
  footerButton: window.__styleOf(document.querySelector(".modal-footer .btn.primary")),
  smallButton: window.__styleOf(document.querySelector(".modal .management-row .btn.sm")),
  footerButtonIcons: document.querySelector(".modal-footer .btn.primary")?.querySelectorAll("svg").length ?? 0,
  smallButtonIcons: document.querySelector(".modal .management-row .btn.sm")?.querySelectorAll("svg").length ?? 0,
  pageButtonIcons: [...document.querySelectorAll(".page .btn")].map((button) => button.querySelectorAll("svg").length),
}), MANAGEMENT_SELECTORS);
await prototypePage.screenshot({ path: `${OUT}/prototype/1440x900-projects-dialog.png` });
await prototypePage.click('[data-action="close-modal"]');
await prototypePage.waitForTimeout(120);

// The project form (`projectDialog()`): repository checkboxes plus directories.
await prototypePage.click('[data-action="edit-project:adber"]');
await prototypePage.waitForTimeout(150);
report.prototypeA.projectForm = await prototypePage.evaluate((selectors) => ({
  ...window.__measure(selectors),
  checkRowCount: document.querySelectorAll(".modal .check-row").length,
  disabledRepos: [...document.querySelectorAll('input[name="project-repo"]')].filter((input) => input.disabled).length,
  usedNotices: [...document.querySelectorAll(".modal .check-row small")].length,
  checkbox: (() => {
    const input = document.querySelector('input[name="project-repo"]');
    if (!input) return null;
    const computed = getComputedStyle(input);
    return { width: computed.width, height: computed.height, accentColor: computed.accentColor };
  })(),
  fieldCount: document.querySelectorAll(".modal .formfield").length,
}), MANAGEMENT_SELECTORS);
await prototypePage.screenshot({ path: `${OUT}/prototype/1440x900-project-form.png` });

// Directory shape: give the prototype's project one ordinary directory, save,
// and go back to the project page.
await prototypePage.click('[data-action="add-project-directory"]');
await prototypePage.waitForTimeout(100);
await prototypePage.fill(".project-directory-row .directory-name", "设计资料");
await prototypePage.fill(".project-directory-row .directory-path", "/Users/leonz3n/Workspace/atlas-docs");
await prototypePage.click('[data-action="save-project:adber"]');
await prototypePage.waitForTimeout(150);
await prototypePage.click('[data-action="view:project"]');
await prototypePage.waitForTimeout(150);
report.prototypeA.directory = await prototypePage.evaluate((selectors) => ({
  ...window.__measure(selectors),
  heading: document.querySelector("h1")?.textContent?.trim() ?? null,
  statCount: document.querySelectorAll(".stat").length,
  rowCount: document.querySelectorAll(".management-row").length,
  badges: [...document.querySelectorAll(".management-row .badge")].map((badge) => badge.textContent.trim()),
  taskCardMeta: [...document.querySelectorAll(".taskcard small")].map((s) => s.textContent.trim()),
}), MANAGEMENT_SELECTORS);
await prototypePage.screenshot({ path: `${OUT}/prototype/1440x900-project-directory.png` });

// 查看生效配置 (`closure.js effectiveConfigDialog()`), reached the way the
// prototype exposes it: the button it injects into the env page's toolbar.
await prototypePage.click('[data-action="view:env"]');
await prototypePage.waitForTimeout(150);
await prototypePage.click('.config-toolbar [data-action="flow-effective"]');
await prototypePage.waitForTimeout(150);
report.prototypeA.effectiveConfig = await prototypePage.evaluate((selectors) => {
  const rows = document.querySelector("#effective-config-rows");
  const table = rows?.querySelector("table");
  return {
    ...window.__measure(selectors),
    header: document.querySelector(".modal-body p")?.textContent?.trim() ?? null,
    wrapped: !!rows?.querySelector(".table-wrap"),
    thCount: table ? table.querySelectorAll("th").length : 0,
    thText: table ? [...table.querySelectorAll("th")].map((th) => th.textContent.trim()) : [],
    bodyRows: table
      ? [...table.querySelectorAll("tr")].slice(1).map((tr) => [...tr.children].map((td) => td.textContent.trim()))
      : [],
    cellTh: window.__styleOf(table?.querySelector("th")),
    cellTd: window.__styleOf(table?.querySelector("td")),
    // `.table tr:last-child td{border:0}` — the last body row carries no bottom
    // border in the prototype.
    lastRowTd: window.__styleOf(table?.querySelector("tr:last-child td")),
    editableFields: rows ? rows.querySelectorAll("input, textarea").length : 0,
    selectors: rows ? rows.querySelectorAll("select").length : 0,
    notes: [...document.querySelectorAll(".modal .note")].map((note) => note.textContent.trim()),
  };
}, MANAGEMENT_SELECTORS);
await prototypePage.screenshot({ path: `${OUT}/prototype/1440x900-effective-config.png` });
await prototypePage.close();

// Per-viewport `.page` padding, read from the prototype at the same widths.
report.prototypeA.pagePaddingByViewport = {};
for (const viewport of VIEWPORTS) {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
  await page.click('[data-action="view:project"]');
  await page.waitForTimeout(120);
  report.prototypeA.pagePaddingByViewport[viewport.name] = await page.evaluate(
    () => getComputedStyle(document.querySelector(".page")).padding,
  );
  await page.close();
}

// ------------------------------------------------------------- renderer side
const ROUTES = {
  repository: `${RENDERER}/projects/orbit`,
  directory: `${RENDERER}/projects/atlas`,
  empty: `${RENDERER}/projects/missing-project`,
};

const measureOverview = (page) =>
  page.evaluate((selectors) => {
    const overview = document.querySelector('[data-testid="project-overview"]');
    const stat = overview?.querySelector(".stat");
    const page_ = document.querySelector('[data-testid="page"]');
    const grids = [...(overview?.querySelectorAll(".grid") ?? [])];
    return {
      viewport: { w: innerWidth, h: innerHeight },
      palette: (() => {
        const root = getComputedStyle(document.documentElement);
        return {
          accent: root.getPropertyValue("--color-accent").trim(),
          soft: root.getPropertyValue("--color-soft").trim(),
          sidebar: root.getPropertyValue("--color-sidebar").trim(),
          bg: root.getPropertyValue("--color-bg").trim(),
        };
      })(),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      page: window.__styleOf(page_),
      pageScrolls: page_ ? page_.scrollHeight > page_.clientHeight : null,
      variant: overview?.dataset.projectVariant ?? null,
      statCount: overview ? overview.querySelectorAll(".stat").length : 0,
      checkRowCount: overview ? overview.querySelectorAll('[data-testid^="project-repo-"]').length : 0,
      directoryRowCount: overview ? overview.querySelectorAll('[data-testid^="project-directory-"]').length : 0,
      badges: overview
        ? [...overview.querySelectorAll(".management-row")].map(
            (row) => row.querySelector(".badge")?.textContent?.trim() ?? null,
          )
        : [],
      taskCards: overview
        ? [...overview.querySelectorAll('[data-testid^="project-task-"]')].map((card) => ({
            testId: card.dataset.testid,
            text: card.textContent.trim(),
            meta: /\d+ 个 Git 仓库 · \d+ 个普通目录/.exec(card.textContent)?.[0] ?? null,
          }))
        : [],
      measured: window.__measure(selectors, overview ?? document),
      grid2: window.__styleOf(grids.find((grid) => grid.querySelector('[data-testid^="project-task-"]'))),
      grid3: window.__styleOf(grids.find((grid) => grid.querySelector(".stat"))),
    };
  }, MANAGEMENT_SELECTORS);

const measureDialog = (page, rootTestId) =>
  page.evaluate((root) => {
    const dialog = document.querySelector(`[data-testid="${root}"]`);
    return {
      present: !!dialog,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      modal: window.__styleOf(dialog),
      // The modal body's *content* width: what the table has to fit into.
      bodyClientWidth: (() => {
        const body = dialog?.firstElementChild?.nextElementSibling;
        if (!body) return null;
        const computed = getComputedStyle(body);
        return Math.round(body.clientWidth - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight));
      })(),
      rows: dialog ? dialog.querySelectorAll(".management-row").length : 0,
      rowEntries: dialog
        ? [...dialog.querySelectorAll(".management-row")].map((row) =>
            [...row.querySelectorAll("button")].map((button) => button.textContent.trim()),
          )
        : [],
      buttons: dialog ? [...dialog.querySelectorAll("button")].map((button) => button.textContent.trim()) : [],
      checkRows: dialog ? dialog.querySelectorAll(".check-row").length : 0,
      checkRowStyle: window.__styleOf(dialog?.querySelector(".check-row")),
      table: window.__styleOf(dialog?.querySelector(".table")),
      th: window.__styleOf(dialog?.querySelector("th")),
      td: window.__styleOf(dialog?.querySelector("td")),
      lastRowTd: window.__styleOf(dialog?.querySelector("tbody tr:last-child td")),
      thText: dialog ? [...dialog.querySelectorAll("th")].map((th) => th.textContent.trim()) : [],
      configRows: dialog
        ? [...dialog.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent.trim()))
        : [],
      wrapped: !!dialog?.querySelector(".table-wrap"),
      editableFields: dialog ? dialog.querySelectorAll('input[type="text"], input:not([type]), textarea').length : 0,
      selectCount: dialog ? dialog.querySelectorAll("select").length : 0,
      saveButtons: dialog
        ? [...dialog.querySelectorAll("button")].filter((button) => /保存|确定/.test(button.textContent)).length
        : 0,
      disabledChoices: dialog
        ? [...dialog.querySelectorAll('input[type="checkbox"]')].filter((input) => input.disabled).length
        : 0,
      usedNotices: dialog ? [...dialog.querySelectorAll(".check-row small")].length : 0,
      checkbox: (() => {
        const input = dialog?.querySelector('input[type="checkbox"]');
        if (!input) return null;
        const computed = getComputedStyle(input);
        return { width: computed.width, height: computed.height, accentColor: computed.accentColor };
      })(),
    };
  }, rootTestId);

const openPage = async (route, viewport) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="project-overview"]');
  return page;
};

for (const viewport of VIEWPORTS) {
  const entry = {};

  for (const variant of ["repository", "directory", "empty"]) {
    const page = await openPage(ROUTES[variant], viewport);
    entry[variant] = await measureOverview(page);
    await page.screenshot({ path: `${OUT}/renderer/${viewport.name}-project-${variant}.png` });

    if (variant === "empty") {
      await page.close();
      continue;
    }

    // 项目管理 dialog (`projectsDialog()`).
    await page.click('[data-testid="project-manage"]');
    await page.waitForSelector('[data-testid="projects-dialog"]');
    entry[`${variant}_projectsDialog`] = await measureDialog(page, "projects-dialog");
    await page.screenshot({ path: `${OUT}/renderer/${viewport.name}-projects-dialog.png` });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="projects-dialog"]', { state: "detached" });

    // 项目表单 (`projectDialog()`): from 管理仓库 in the repository shape, and
    // through 项目管理 → 编辑 in the directory shape, because there the page's
    // 管理目录 opens the app's dedicated 管理普通目录 dialog (declared
    // deviation) which is measured here as well.
    if (variant === "repository") {
      await page.click('[data-testid="project-repos-manage"]');
      await page.waitForSelector('[data-testid="project-editor"]');
    } else {
      await page.click('[data-testid="project-directories-manage"]');
      await page.waitForSelector('[data-testid="project-directories-dialog"]');
      entry[`${variant}_projectDirectoriesDialog`] = await measureDialog(page, "project-directories-dialog");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="project-directories-dialog"]', { state: "detached" });
      await page.click('[data-testid="project-manage"]');
      await page.waitForSelector('[data-testid="projects-dialog"]');
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid="projects-dialog"] .management-row')].find((item) =>
          item.textContent.includes("Atlas Web"),
        );
        [...row.querySelectorAll("button")].find((button) => button.textContent.trim() === "编辑").click();
      });
      await page.waitForSelector('[data-testid="project-editor"]');
    }
    entry[`${variant}_projectForm`] = await measureDialog(page, "project-editor");
    await page.screenshot({ path: `${OUT}/renderer/${viewport.name}-project-form.png` });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="project-editor"]', { state: "detached" });

    // 查看生效配置 (`effectiveConfigDialog()`), the env page's toolbar entry.
    await page.goto(`${RENDERER}/env`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="env-effective-config"]');
    await page.click('[data-testid="env-effective-config"]');
    await page.waitForSelector('[data-testid="effective-config-dialog"]');
    entry[`${variant}_effectiveConfig`] = await measureDialog(page, "effective-config-dialog");
    await page.screenshot({ path: `${OUT}/renderer/${viewport.name}-effective-config.png` });

    await page.close();
  }

  report.renderer[viewport.name] = entry;
}

// ------------------------------------------------- button geometry comparison
//
// Recorded, not asserted: the prototype's `.btn{padding:7px 11px;font-size:12px;
// border-radius:7px}` / `.btn.sm{padding:4px 8px;font-size:11px}` against this
// app's `Button`. Changing it repaints every earlier slice and drops in an icon
// on most buttons, so it is reported for a decision instead of patched here.
{
  const prototypeButton = report.prototypeA.projectsDialog;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTES.repository, { waitUntil: "networkidle" });
  await page.click('[data-testid="project-manage"]');
  await page.waitForSelector('[data-testid="projects-dialog"]');
  const rendererButton = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="projects-dialog"] footer');
    const button = footer?.querySelector("button.btn") ?? footer?.querySelector("button");
    const small = document.querySelector('[data-testid="projects-dialog"] .management-row button.btn');
    const read = (element) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        padding: computed.padding,
        fontSize: computed.fontSize,
        borderRadius: computed.borderTopLeftRadius,
        gap: computed.gap,
        iconCount: element.querySelectorAll("svg").length,
      };
    };
    // The icon side of the deviation, measured the same way as the prototype's
    // `pageButtons` / `footerPrimary` / `rowSmall` — it used to be read off the
    // source instead of measured.
    const overview = document.querySelector('[data-testid="project-overview"]');
    return {
      primary: read(button),
      small: read(small),
      icons: {
        footerPrimary: button?.querySelectorAll("svg").length ?? null,
        rowSmall: small?.querySelectorAll("svg").length ?? null,
        pageButtons: overview
          ? [...overview.querySelectorAll("button")]
              .filter((element) => element.classList.contains("btn"))
              .map((element) => element.querySelectorAll("svg").length)
          : null,
      },
    };
  });
  report.geometry.button = {
    prototype: {
      primary: styleOfShallow(prototypeButton.footerButton),
      small: styleOfShallow(prototypeButton.smallButton),
      icons: {
        footerPrimary: prototypeButton.footerButtonIcons,
        rowSmall: prototypeButton.smallButtonIcons,
        pageButtons: prototypeButton.pageButtonIcons,
      },
    },
    renderer: rendererButton,
  };
  await page.close();
}

// ------------------------------------------------------------- read-only check
{
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${RENDERER}/env`, { waitUntil: "networkidle" });
  await page.click('[data-testid="env-effective-config"]');
  await page.waitForSelector('[data-testid="effective-config-dialog"]');
  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="effective-config-dialog"] tbody tr')].map((row) =>
        [...row.children].map((cell) => cell.textContent.trim()),
      ),
    );
  const before = await read();
  await page.evaluate(() => {
    const select = document.querySelector('[data-testid="effective-service"]');
    select.selectedIndex = Math.min(1, select.options.length - 1);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const after = await read();
  report.geometry.serviceSwitch = { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  await page.close();
}

// ---------------------------------------------------------- task workspace entry
{
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${RENDERER}/projects/atlas/tasks/release?session=main`, { waitUntil: "networkidle" });
  await page.click('[data-testid="tool-launcher-runtime"]');
  await page.waitForSelector('[data-testid="tool-effective-config"]');
  await page.click('[data-testid="tool-effective-config"]');
  await page.waitForSelector('[data-testid="effective-config-dialog"]');
  report.geometry.workspaceEntry = await measureDialog(page, "effective-config-dialog");
  await page.screenshot({ path: `${OUT}/renderer/1440x900-effective-config-from-workspace.png` });
  await page.close();
}

// ------------------------------------------------------------------ assertions
const at1440 = report.renderer["1440x900"];
const repo1440 = at1440.repository;
const dir1440 = at1440.directory;
const prototypeRepo = report.prototypeA.repository;
const prototypeDir = report.prototypeA.directory;
const prototypeDialog = report.prototypeA.projectsDialog;
const prototypeConfig = report.prototypeA.effectiveConfig;
const prototypeForm = report.prototypeA.projectForm;
const prototypePagePad = report.prototypeA.pagePaddingByViewport;

// 0. Palette: recorded, not asserted. The prototype's stylesheet ends with a
//    "Review revision" layer that overrides the base palette
//    (`:root{--accent:#4668cc;--soft:#edf1fc;--sidebar:#f4f5f7;--bg:#f6f7f9}`),
//    while `styles/tokens.css` carries the base values. Resolving that is an
//    epic-wide decision (it repaints every earlier slice), so this slice reports
//    the measured difference instead of changing it here.
report.palette = {
  prototype: prototypeRepo.palette,
  renderer: repo1440.palette,
  differs: Object.keys(prototypeRepo.palette).filter(
    (token) => prototypeRepo.palette[token].toLowerCase() !== (repo1440.palette[token] ?? "").toLowerCase(),
  ),
};

// 1. `.page` padding / background / scrollability per tier, against the
//    prototype at the same width (including its 25px and 20px tiers).
for (const viewport of VIEWPORTS) {
  const measured = report.renderer[viewport.name];
  for (const variant of ["repository", "directory"]) {
    check(
      `page padding @${viewport.name}/${variant}`,
      measured[variant].page.padding === prototypePagePad[viewport.name],
      `renderer ${measured[variant].page.padding} vs prototype ${prototypePagePad[viewport.name]}`,
    );
    check(
      `page background @${viewport.name}/${variant}`,
      measured[variant].page.backgroundColor === prototypeRepo.page.backgroundColor,
      `renderer ${measured[variant].page.backgroundColor} vs prototype ${prototypeRepo.page.backgroundColor}`,
    );
    check(`page scrolls @${viewport.name}/${variant}`, measured[variant].page.overflowY === "auto", `overflowY ${measured[variant].page.overflowY}`);
  }
}

// 2. No horizontal overflow at any tier, on the pages and inside the dialogs.
for (const viewport of VIEWPORTS) {
  const measured = report.renderer[viewport.name];
  for (const variant of ["repository", "directory", "empty"]) {
    check(
      `no horizontal overflow @${viewport.name}/${variant}`,
      measured[variant].noHorizontalOverflow === true,
      "document scrollWidth > clientWidth",
    );
  }
  for (const key of [
    "repository_projectsDialog",
    "repository_projectForm",
    "repository_effectiveConfig",
    "directory_projectsDialog",
    "directory_projectForm",
    "directory_projectDirectoriesDialog",
    "directory_effectiveConfig",
  ]) {
    const dialog = measured[key];
    if (!dialog) continue;
    check(
      `no horizontal overflow @${viewport.name}/${key}`,
      dialog.noHorizontalOverflow === true,
      "document scrollWidth > clientWidth",
    );
  }
  const config = measured.repository_effectiveConfig;
  // Prototype `@media(max-width:720px){.table{min-width:650px}}` keeps the three
  // columns readable: the modal body scrolls, the document does not.
  if (config && viewport.width <= 720) {
    check(`effective config table floor @${viewport.name}`, config.table.width >= 650, `table width ${config.table.width}`);
    check(
      `effective config body scrolls @${viewport.name}`,
      config.table.width > config.bodyClientWidth,
      `table ${config.table.width} vs dialog inner width ${config.bodyClientWidth}`,
    );
  }
}

// 3. `.card` / `.stat` / `.grid` block, against the prototype's repository page.
const same = (a, b, keys, label) =>
  check(label, pick(a, keys) === pick(b, keys), `${pick(a, keys)} vs ${pick(b, keys)}`);

same(repo1440.measured.card, prototypeRepo.card, ["padding", "borderRadius", "backgroundColor", "borderWidth"], "card box");
// The prototype's `h2` has no declared weight: both sides must compute 700.
same(repo1440.measured.sectionTitle, prototypeRepo.sectionTitle, ["fontSize", "fontWeight", "letterSpacing", "color"], "section title");
same(repo1440.measured.stat, prototypeRepo.stat, ["fontSize", "fontWeight", "letterSpacing", "marginTop", "color"], "stat");
same(
  repo1440.measured.viewLabel,
  prototypeRepo.viewLabel,
  ["fontSize", "letterSpacing", "textTransform", "color", "marginBottom"],
  "view label",
);
same(repo1440.measured.pageIntro, prototypeRepo.pageIntro, ["fontSize", "color", "marginTop", "marginBottom"], "page intro");
same(repo1440.measured.checkRow, prototypeRepo.checkRow, ["padding", "gap", "fontSize", "borderWidth"], "check row");
same(dir1440.measured.managementList, prototypeDir.managementList, ["gap", "gridTemplateColumns"], "management list");
same(dir1440.measured.managementRow, prototypeDir.managementRow, ["padding", "gap", "borderWidth"], "management row");
same(dir1440.measured.note, prototypeDir.note, ["fontSize", "color", "marginTop", "letterSpacing"], "note");

// `.grid3` / `.grid2` columns per tier, the prototype's own degradation.
for (const viewport of VIEWPORTS) {
  const measured = report.renderer[viewport.name].repository;
  const columns3 = measured.grid3?.gridTemplateColumns?.split(" ").length ?? 0;
  const columns2 = measured.grid2?.gridTemplateColumns?.split(" ").length ?? 0;
  check(`grid3 columns @${viewport.name}`, columns3 === (viewport.width <= 960 ? 1 : 3), `${columns3} columns`);
  check(`grid2 columns @${viewport.name}`, columns2 === (viewport.width <= 720 ? 1 : 2), `${columns2} columns`);
  check(
    `grid gap @${viewport.name}`,
    measured.grid3?.gap === prototypeRepo.grid3.gap,
    `${measured.grid3?.gap} vs ${prototypeRepo.grid3.gap}`,
  );
}

// 4. 项目管理 dialog: its rows, its four entries, and the modal box.
const projectsDialog = at1440.repository_projectsDialog;
check("projects dialog present", projectsDialog.present, "dialog missing");
// One row per project (the prototype's own seed has one, ours two), and every
// row carries the prototype's own entry set: 当前项目/切换 + 编辑 + 删除.
check("projects dialog rows", projectsDialog.rows >= 1 && projectsDialog.rowEntries.length === projectsDialog.rows, `${projectsDialog.rows} rows`);
check(
  "projects dialog row entry shape",
  projectsDialog.rowEntries.every(
    (set) => set.length === prototypeDialog.entries[0].length && set.includes("编辑") && set.includes("删除"),
  ),
  `${JSON.stringify(projectsDialog.rowEntries)} vs prototype row ${JSON.stringify(prototypeDialog.entries[0])}`,
);
check(
  "projects dialog labels the current project and the others 切换",
  projectsDialog.rowEntries.some((set) => set.includes("当前项目")) &&
    projectsDialog.rowEntries.filter((set) => set.includes("切换")).length === projectsDialog.rows - 1,
  JSON.stringify(projectsDialog.rowEntries),
);
for (const label of ["编辑", "删除", "新建项目"]) {
  check(`projects dialog has ${label}`, projectsDialog.buttons.includes(label), projectsDialog.buttons.join(","));
}
same(projectsDialog.modal, prototypeDialog.modal, ["borderRadius", "backgroundColor", "width"], "modal box");

// 5. Both prototype project shapes, plus the anti-no-op pair: the repository
//    shape shows the stat cards and no 项目目录 list, the directory shape the
//    other way round. A silently empty page fails here.
check("Orbit renders the repository shape", repo1440.variant === "repository", `variant ${repo1440.variant}`);
check("Atlas renders the directory shape", dir1440.variant === "directory", `variant ${dir1440.variant}`);
check(
  "repository shape stat cards",
  repo1440.statCount === prototypeRepo.statCount && repo1440.statCount === 3,
  `${repo1440.statCount} vs prototype ${prototypeRepo.statCount}`,
);
check("repository shape has no 项目目录 list", repo1440.measured.managementList === null, "management list present");
// Orbit API binds one repository, so the repository shape lists exactly one
// `.check-row`; a page that rendered nothing would fail here.
check(
  "repository shape lists its bound repository",
  repo1440.checkRowCount === 1 && repo1440.directoryRowCount === 0,
  `${repo1440.checkRowCount} repository rows, ${repo1440.directoryRowCount} directory rows`,
);
check(
  "directory shape has no stat cards",
  dir1440.statCount === prototypeDir.statCount && dir1440.statCount === 0,
  `${dir1440.statCount} vs prototype ${prototypeDir.statCount}`,
);
// Atlas Web binds 4 repositories and owns 1 ordinary directory: the prototype's
// own mixed list, which happens to be 5 rows as well.
check(
  "directory shape mixes both kinds",
  dir1440.checkRowCount + dir1440.directoryRowCount === dir1440.badges.length &&
    dir1440.checkRowCount === 4 &&
    dir1440.directoryRowCount === 1,
  `${dir1440.checkRowCount} repos + ${dir1440.directoryRowCount} dirs vs ${dir1440.badges.length} rows`,
);
check("directory shape row count", dir1440.badges.length === prototypeDir.rowCount, `${dir1440.badges.length} vs ${prototypeDir.rowCount}`);
check(
  "directory shape badges",
  JSON.stringify(dir1440.badges) === JSON.stringify(prototypeDir.badges),
  `${JSON.stringify(dir1440.badges)} vs ${JSON.stringify(prototypeDir.badges)}`,
);
const META = /^\d+ 个 Git 仓库 · \d+ 个普通目录$/;
check(
  "directory shape task cards count both kinds",
  dir1440.taskCards.length > 0 && dir1440.taskCards.every((card) => META.test(card.meta ?? "")),
  JSON.stringify(dir1440.taskCards.map((card) => card.meta)),
);
check(
  "prototype task cards use the same meta",
  prototypeDir.taskCardMeta.length > 0 && prototypeDir.taskCardMeta.every((meta) => META.test(meta)),
  JSON.stringify(prototypeDir.taskCardMeta),
);
check(
  "directory shape counts the project's own directories",
  dir1440.taskCards.some((card) => (card.meta ?? "").endsWith("· 1 个普通目录")),
  JSON.stringify(dir1440.taskCards.map((card) => card.meta)),
);
check("empty shape", at1440.empty.variant === null && at1440.empty.statCount === 0, `variant ${at1440.empty.variant}`);

// 6. 项目表单: the task-used repositories are disabled and explained, in the
//    prototype's `.check-row` geometry with the prototype's checkbox.
const form = at1440.repository_projectForm;
check("project form present", form.present, "dialog missing");
same(
  form.checkRowStyle,
  prototypeForm.checkRow,
  ["padding", "gap", "fontSize", "borderWidth"],
  "project form check row",
);
check("project form disables used repos", form.disabledChoices >= 1, `${form.disabledChoices} disabled`);
check("project form explains disabled repos", form.usedNotices >= 1, `${form.usedNotices} notices`);
check(
  "project form disables only used repos",
  form.disabledChoices < form.checkRows,
  `all ${form.checkRows} rows disabled`,
);
same(form.checkbox, prototypeForm.checkbox, ["width", "height"], "project form checkbox");
// Palette note: the prototype's final "review revision" layer overrides
// `--accent` to #4668cc while this app's token is the base #233c78, so the
// checkbox accent is reported rather than asserted equal.
report.geometry.checkboxAccent = { renderer: form.checkbox?.accentColor, prototype: prototypeForm.checkbox?.accentColor };
check(
  "directory shape keeps its own directory dialog",
  at1440.directory_projectDirectoriesDialog?.present === true,
  "管理普通目录 did not open",
);

// 7. 查看生效配置: KEY / 最终值 / 来源, the four source layers, read-only.
const config = at1440.repository_effectiveConfig;
check("effective config present", config.present, "dialog missing");
check(
  "effective config headers",
  JSON.stringify(config.thText) === JSON.stringify(["KEY", "最终值", "来源"]),
  config.thText.join(","),
);
check("effective config rows", config.configRows.length >= 4, `${config.configRows.length} rows`);
const sources = config.configRows.map((row) => row[2]);
for (const layer of ["仓库默认配置", "共享模板", "本机私有配置", "任务覆盖"]) {
  check(`effective config source ${layer}`, sources.some((source) => source.startsWith(layer)), sources.join(" | "));
}
check("effective config is a bare table", config.wrapped === false, "table wrapped in .table-wrap");
check("effective config has one control", config.selectCount === 1, `${config.selectCount} selects`);
check("effective config has no editable field", config.editableFields === 0, `${config.editableFields} inputs`);
check("effective config has no save", config.saveButtons === 0, `${config.saveButtons} save buttons`);
check("effective config follows the service", report.geometry.serviceSwitch.changed === true, "rows identical after switching service");
check(
  "effective config reachable from the workspace",
  report.geometry.workspaceEntry.present === true,
  "workspace entry did not open the dialog",
);
same(config.th, prototypeConfig.cellTh, ["padding", "backgroundColor", "fontSize", "color", "fontWeight"], "config table th");
same(config.td, prototypeConfig.cellTd, ["padding", "fontSize"], "config table td");
// `.table tr:last-child td{border:0}`: the last row carries no bottom border.
same(config.lastRowTd, prototypeConfig.lastRowTd, ["borderWidth"], "config table last row border");
check(
  "config table matches the prototype's row count shape",
  config.configRows.every((row) => row.length === prototypeConfig.bodyRows[0].length),
  `${config.configRows.length} rows of ${config.configRows[0]?.length} cells`,
);
check(
  "the prototype's three notes are carried over",
  prototypeConfig.notes.some(
    (note) =>
      note.includes("未保存草稿不参与") && note.includes("需运行时核对") && note.includes("需显式重启受影响服务"),
  ),
  JSON.stringify(prototypeConfig.notes),
);

// 8. Modal width: the prototype's `min(660px,100%)` at every tier.
for (const viewport of VIEWPORTS) {
  const measured = report.renderer[viewport.name];
  for (const key of ["repository_projectsDialog", "repository_effectiveConfig", "repository_projectForm"]) {
    const dialog = measured[key];
    if (!dialog) continue;
    const expected = Math.min(660, viewport.width - 50);
    check(
      `modal width @${viewport.name}/${key}`,
      Math.abs(dialog.modal.width - expected) <= 1,
      `${dialog.modal.width} vs ${expected}`,
    );
  }
}

await writeFile(`${OUT}/management.json`, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `[UI 对齐 08] #32 evidence: ${report.assertions.violations.length === 0 ? "ok" : "FAILED"} ` +
    `(${report.assertions.checked} assertions, ${Object.keys(report.renderer).length} viewport tiers, ` +
    `prototype repo shape: ${prototypeRepo.statCount} stat cards / directory shape: ${prototypeDir.rowCount} rows)`,
);
for (const violation of report.assertions.violations) console.log(`  - ${violation}`);
await chrome.close();
process.exit(report.assertions.violations.length === 0 ? 0 : 1);
