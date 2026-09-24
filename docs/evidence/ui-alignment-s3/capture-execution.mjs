// [UI 对齐 05] (#29) session-navigation + execution-card evidence.
//
// jsdom has no layout, so the two geometry claims of the slice are measured in
// headless Chromium: the tab strip never clips at any tier (with and without the
// tool rail), and the execution card's height is charged against the message
// area the [UI 对齐 03] (#27) baseline measured at 408px. Run with the renderer
// dev server on 4335 and the prototype on 4319:
//
//   node docs/evidence/ui-alignment-s3/capture-execution.mjs
//
// Images and JSON are written next to this file so the evidence stays
// reproducible from the repository (same convention as `ui-alignment-s1/s2/s5`).

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
const task = (id, session) => `${RENDERER}/projects/atlas/tasks/${id}?session=${session}`;
const ALL_PANELS = ["运行", "协议", "浏览器", "文件", "终端", "日志"];
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
  { name: "900x800", width: 900, height: 800 },
  { name: "720x760", width: 720, height: 760 },
];

const measureTabs = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector('[data-testid="session-tab-strip"]');
    const tabs = [...document.querySelectorAll('[data-testid^="session-tab-"]')].filter(
      (element) => element.getAttribute("data-testid") !== "session-tab-strip",
    );
    return {
      viewport: { w: innerWidth, h: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      strip: strip
        ? {
            scrollWidth: strip.scrollWidth,
            clientWidth: strip.clientWidth,
            // The [UI 对齐 03] (#27) residual: content wider than the box.
            clipPx: Math.max(0, strip.scrollWidth - strip.clientWidth),
            noClip: strip.scrollWidth <= strip.clientWidth,
            h: Math.round(strip.getBoundingClientRect().height),
          }
        : null,
      tabs: tabs.map((tab) => {
        const label = tab.querySelector("span");
        return {
          id: tab.getAttribute("data-testid"),
          text: (label?.textContent ?? "").trim(),
          visible: tab.getClientRects().length > 0,
          w: Math.round(tab.getBoundingClientRect().width),
          // A truncated label still reports the full text, so measure the span.
          labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
        };
      }),
      visibleTabs: tabs.filter((tab) => tab.getClientRects().length > 0).length,
      addButton: (() => {
        const button = document.querySelector('[data-testid="session-tab-strip"] ~ button[aria-label="新建会话"], button[aria-label="新建会话"]');
        return button ? { w: Math.round(button.getBoundingClientRect().width), visible: button.getClientRects().length > 0 } : null;
      })(),
    };
  });

const measureCard = (page) =>
  page.evaluate(() => {
    const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
    const card = document.querySelector('[data-testid="execution-card"]');
    const messages = document.querySelector('[role="log"][aria-label="会话消息"]');
    const part = (selector) => box(card?.querySelector(selector) ?? null);
    return {
      viewport: { w: innerWidth, h: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      messagesH: box(messages),
      messagesShare: messages ? Number((messages.getBoundingClientRect().height / innerHeight).toFixed(3)) : null,
      cardPresent: card !== null,
      cardH: box(card),
      cardScrolls: card ? card.scrollHeight > card.clientHeight + 1 : null,
      cardParts: {
        stateRow: part("div"),
        topLevelChildren: [...(card?.children ?? [])].map((element) => ({ tag: element.tagName.toLowerCase(), h: box(element) })),
      },
      state: card?.querySelector('[data-testid="execution-card-state"]')?.textContent?.trim() ?? null,
      actions: [...(card?.querySelectorAll("button") ?? [])].map((button) => ({
        label: button.textContent?.trim(),
        disabled: button.disabled,
      })),
      approvalPreview: part('[data-testid="execution-approval-preview"]'),
      otherSession: part('[data-testid="execution-other-session"]'),
      steps: part('[data-testid="execution-steps"]'),
      cardText: (card?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160),
      composerApprovalCard: box([...document.querySelectorAll("section h2")].find((h2) => h2.textContent === "等待确认")?.closest("section") ?? null),
    };
  });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { renderer: RENDERER, prototype: PROTOTYPE, tabStrip: {}, card: {} };
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

async function openPanels(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0) {
      await button.first().click();
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------- tab strip
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  for (const [tier, panels] of [["closed", []], ["one", [ALL_PANELS[3]]], ["all", ALL_PANELS]]) {
    await page.goto(task("release", "main"), { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await openPanels(page, panels);
    const measured = await measureTabs(page);
    report.tabStrip[`${viewport.name}-${tier}`] = measured;
    await page.screenshot({ path: `${OUT}/renderer/${viewport.width}x${viewport.height}-tabs-${tier}.png` });
  }
  await context.close();
}

// ------------------------------------------------------------ execution card
//
// Every state is driven through the real UI (the seeded release task has two
// pending confirmations on 部署审查 and a scripted failing session), so the
// screenshots show the same card a user would see.
async function withPage(fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

async function capture(name, prepare) {
  await withPage(async (page, context) => {
    const notes = await prepare(page, context);
    const measured = { ...(await measureCard(page)), notes: notes ?? null };
    report.card[name] = measured;
    await page.screenshot({ path: `${OUT}/renderer/1440-card-${name}.png` });
    console.log(
      `card ${name}: state=${measured.state} card=${measured.cardH} messages=${measured.messagesH} actions=${JSON.stringify(measured.actions)}`,
    );
  });
}

const sendToComposer = async (page, text) => {
  const input = page.getByLabel("消息输入");
  await input.click();
  await input.fill(text);
  await page.getByRole("button", { name: "发送消息" }).click();
};

const expirePending = async (page) => {
  const button = page.getByRole("button", { name: "标记过期" });
  await button.first().click();
  await page.waitForTimeout(300);
};

await capture("idle-other-busy", async (page) => {
  // 实现与验证 is idle while 部署审查 holds two pending confirmations.
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return "空闲会话 + 其它会话等待确认（原型 other>=0 分支）";
});

await capture("approval", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return "等待确认：预览取自 Host 待确认请求（目标/影响/有效期）";
});

await capture("running", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // Reject the first request, then approve the second: the approved turn runs.
  await page.getByRole("button", { name: "拒绝" }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "批准本次操作" }).first().click();
  await page.waitForTimeout(300);
  return "批准第二条待确认请求后进入执行中（会话 runState=running）";
});

await capture("stopped", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "拒绝" }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "批准本次操作" }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "停止执行" }).first().click();
  await page.waitForTimeout(400);
  return "停止执行走既有 stopRun；卡片回到已停止且不再提供入口";
});

await capture("rejected", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "拒绝" }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "拒绝" }).first().click();
  await page.waitForTimeout(400);
  return "两条请求都拒绝后会话落到已拒绝";
});

await capture("expired-second-pending", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // 标记过期 belongs to the composer's payload review and the seeded session has
  // two pending requests. Expiring the first settles the session as 确认已过期
  // (the record keeps that state) but the second request is still pending, and
  // a pending request outranks the record — so this capture documents the gap:
  // the second request has no expiry entry anywhere in the UI, which is why the
  // 确认已过期 card itself is asserted in `executionCardFlow.test.tsx` instead.
  await expirePending(page);
  await page.waitForTimeout(300);
  return "第一条确认过期后：会话记录已是 expired，但第二条仍待确认（无过期入口）";
});

await capture("failed", async (page) => {
  await page.goto(task("release", "failed"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await sendToComposer(page, "修复构建并重试");
  await page.getByRole("button", { name: "检查并重试" }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(200);
  return "失败排查会话的真实失败回合：失败范围 + 折叠的步骤";
});

await capture("completed", async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await sendToComposer(page, "看一下这次改动");
  await page.waitForTimeout(1200);
  return "普通回合结束后的已完成状态（无入口）";
});

// -------------------------------------------------------- prototype reference
await withPage(async (page) => {
  await page.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const panelGeometry = (label) =>
    page.evaluate((tier) => {
      const panel = document.querySelector(".execution-panel");
      const box = (selector) => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().height) : null;
      };
      return {
        tier,
        panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        panelW: panel ? Math.round(panel.getBoundingClientRect().width) : null,
        state: panel?.querySelector("strong")?.textContent?.trim() ?? null,
        approvalPreviewH: box(".approval-preview"),
        text: (panel?.innerText ?? "").replace(/\s+/g, " ").slice(0, 200),
      };
    }, label);
  report.prototypeExecutionPanel = { idle: await panelGeometry("idle") };
  // The panel carries its own demo switcher (投影片：not ported); use it to
  // measure the waiting tier, which is the tallest one prototype A defines.
  await page.locator(".execution-panel details.execution-demo summary").click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "模拟等待确认" }).click();
  await page.waitForTimeout(300);
  report.prototypeExecutionPanel.waiting = await panelGeometry("waiting");
  report.prototypeExecutionPanel.css = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    });
    return rules.filter((rule) => rule.includes("execution-panel") || rule.includes("session-tabs") || rule.includes("sessions{"));
  });
  await page.screenshot({ path: `${OUT}/prototype/1440-prototype-execution-panel.png` });
});

/**
 * The slice's geometry claims as assertions, so re-running this file is a real
 * check rather than a capture: the strip never clips and never truncates a tab
 * label, the tiers show 4 / 4 / 2 / 1 / 1 tabs, and no card scrolls internally.
 */
function assertGeometry(measured) {
  const violations = [];
  for (const [key, value] of Object.entries(measured.tabStrip)) {
    if (value.strip && value.strip.clipPx > 0) violations.push(`${key}: tab strip clips by ${value.strip.clipPx}px`);
    for (const tab of value.tabs) if (tab.labelClipped) violations.push(`${key}: label of ${tab.id} is truncated`);
    if (value.noHorizontalOverflow !== true) violations.push(`${key}: page overflows horizontally`);
    const width = Number(key.split("x")[0]);
    const expected = width >= 1280 ? 4 : width >= 1024 ? 2 : 1;
    if (value.visibleTabs !== expected) violations.push(`${key}: expected ${expected} visible tabs, measured ${value.visibleTabs}`);
  }
  for (const [name, state] of Object.entries(measured.card)) {
    if (state.cardPresent && state.cardScrolls) violations.push(`${name}: card scrolls inside its max-height`);
    if (state.noHorizontalOverflow !== true) violations.push(`${name}: page overflows horizontally`);
  }
  if (violations.length > 0) throw new Error(`geometry assertions failed:\n- ${violations.join("\n- ")}`);
  return Object.keys(measured.tabStrip).length + Object.keys(measured.card).length;
}

await browser.close();
report.assertions = { checked: assertGeometry(report), violations: 0 };
await writeFile(`${OUT}/execution-card.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log("--- tab strip clipping (px over the box) ---");
for (const [key, value] of Object.entries(report.tabStrip)) {
  console.log(`${key}: clip=${value.strip?.clipPx} visibleTabs=${value.visibleTabs} labelClipped=${value.tabs.some((tab) => tab.labelClipped)} overflow=${!value.noHorizontalOverflow}`);
}
console.log(`prototype panel: idle=${report.prototypeExecutionPanel.idle.panelH}px waiting=${report.prototypeExecutionPanel.waiting.panelH}px`);
console.log(`geometry assertions: ok (${report.assertions.checked} measured states)`);
console.log(`wrote ${OUT}/execution-card.json`);
