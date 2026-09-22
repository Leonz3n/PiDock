import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { CHROME, EVIDENCE_DIR, RENDERER_BASE, VIEWPORT } from "./evidence.mjs";

/**
 * π 标记居中检查。jsdom 没有布局，因此对真实 dev server 运行：测量品牌圆形
 * 徽标的 border box 与字形本身的 bounding box（用 Range 选中文本节点），断言
 * 两者中心对齐。同时确认字形使用强调蓝色（不是绿色）。结果写入证据目录。
 *
 * Usage: node packages/renderer/scripts/verify-brand.mjs
 * Requires the renderer dev server on RENDERER_BASE (default 4335).
 */

const TOLERANCE_PX = 1.5;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const checks = {};
let failed = false;
const assert = (name, condition, detail) => {
  checks[name] = { pass: Boolean(condition), detail };
  if (!condition) failed = true;
};

try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${RENDERER_BASE}/attention`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="brand-mark"]');

  const metrics = await page.$eval('[data-testid="brand-mark"]', (element) => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const glyph = range.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: element.textContent?.trim() ?? "",
      box: { width: box.width, height: box.height, left: box.left, top: box.top },
      glyph: { width: glyph.width, height: glyph.height },
      offsetX: (glyph.left + glyph.right) / 2 - (box.left + box.right) / 2,
      offsetY: (glyph.top + glyph.bottom) / 2 - (box.top + box.bottom) / 2,
      color: style.color,
      display: style.display,
      placeItems: style.placeItems,
      borderRadius: style.borderTopLeftRadius,
    };
  });

  assert("glyph-is-pi", metrics.text === "π", metrics);
  assert("badge-is-square", Math.abs(metrics.box.width - metrics.box.height) <= 0.5, metrics.box);
  assert("badge-is-circular", Number.parseFloat(metrics.borderRadius) >= metrics.box.width / 2, { borderRadius: metrics.borderRadius });
  assert("uses-grid-centering", metrics.display === "grid" && metrics.placeItems === "center", {
    display: metrics.display,
    placeItems: metrics.placeItems,
  });
  assert("glyph-centered-horizontally", Math.abs(metrics.offsetX) <= TOLERANCE_PX, { offsetX: metrics.offsetX, tolerance: TOLERANCE_PX });
  assert("glyph-centered-vertically", Math.abs(metrics.offsetY) <= TOLERANCE_PX, { offsetY: metrics.offsetY, tolerance: TOLERANCE_PX });
  assert("glyph-uses-accent-blue", metrics.color === "rgb(35, 60, 120)", { color: metrics.color });

  await mkdir(EVIDENCE_DIR, { recursive: true });
  const target = page.locator('[data-testid="brand-mark"]');
  await target.screenshot({ path: `${EVIDENCE_DIR}renderer/brand-mark.png` });

  checks.pageErrors = errors;
  assert("no-page-errors", errors.length === 0, errors);

  const report = { metrics, checks, failed };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(`${EVIDENCE_DIR}brand-mark-verification.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${EVIDENCE_DIR}brand-mark-verification.json`);
  await context.close();
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
