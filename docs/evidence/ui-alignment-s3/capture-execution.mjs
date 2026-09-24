// [UI 对齐 05] (#29) session-navigation + execution-card evidence.
//
// jsdom has no layout, so the two geometry claims of the slice are measured in
// headless Chromium: the tab strip never clips at any tier (with and without the
// tool rail — each tier is paired with a closed row so the rail cannot silently
// stay shut), and the execution card's height is charged against the message
// area the [UI 对齐 03] (#27) baseline measured at 408px. The floor is tiered
// ([UI 对齐 05] (#29) parent ruling): 340px in the states whose column only holds
// the card, 300px in the states that also carry chrome from outside this slice.
// Run with the renderer dev server on 4335 and the prototype on 4319:
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
const ALL_PANELS = ["runtime", "protocol", "browser", "files", "terminal", "logs"];
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1200x900", width: 1200, height: 900 },
  { name: "1181x900", width: 1181, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
  { name: "900x800", width: 900, height: 800 },
  { name: "720x760", width: 720, height: 760 },
];
// `below-wide` is `@media (max-width:1180px)`, so the 4-tab tier owns 1181px and
// up; the boundary viewports above pin that down.
const LONG_NAME = "跨仓库发布回归验证会";
const LONG_NAME_VIEWPORTS = [1181, 1200, 1240, 1277, 1280, 1440];

const measureTabs = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector('[data-testid="session-tab-strip"]');
    const tabs = [...document.querySelectorAll('[data-testid^="session-tab-"]')].filter(
      (element) => element.getAttribute("data-testid") !== "session-tab-strip",
    );
    const overflowX = strip ? getComputedStyle(strip).overflowX : null;
    const stripBox = strip?.getBoundingClientRect();
    return {
      // This strip scrolls the tab list itself (`overflow-x:auto`), so a crowded
      // row stays reachable instead of cutting a label: overflow is only a defect
      // when it cannot be scrolled. (The prototype scrolls the *row*
      // `.sessions{overflow-x:auto}` while its own `.session-tabs` is
      // `overflow:hidden` — see the P2-B note above the long-name sweep.)
      overflowX,
      scrollable: overflowX === "auto" || overflowX === "scroll",
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
        const box = tab.getBoundingClientRect();
        return {
          id: tab.getAttribute("data-testid"),
          text: (label?.textContent ?? "").trim(),
          visible: tab.getClientRects().length > 0,
          active: tab.className.includes("text-accent"),
          w: Math.round(box.width),
          insideStrip: stripBox ? box.left >= stripBox.left - 1 && box.right <= stripBox.right + 1 : null,
          // A truncated label still reports the full text, so measure the span.
          labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
        };
      }),
      visibleTabs: tabs.filter((tab) => tab.getClientRects().length > 0).length,
      addButton: (() => {
        const button = document.querySelector('[data-testid="session-new"]');
        return button ? { w: Math.round(button.getBoundingClientRect().width), visible: button.getClientRects().length > 0 } : null;
      })(),
      // Measured, never assumed: the tool rail is what makes the strip narrow, so a
      // capture that claims "with the tool rail" has to see the rail.
      railOpen: document.querySelector('[data-testid="task-rail"]') !== null,
      railW: (() => {
        const rail = document.querySelector('[data-testid="task-rail"]');
        return rail ? Math.round(rail.getBoundingClientRect().width) : 0;
      })(),
    };
  });

const measureCard = (page) =>
  page.evaluate(() => {
    const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
    const card = document.querySelector('[data-testid="execution-card"]');
    const messages = document.querySelector('[data-testid="task-workspace"] [role="log"]');
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
      // The read-only rule is a visible element (a disabled button never shows its
      // `title`); it sits in the state row so it cannot push the card past the
      // guardrail ([UI 对齐 05] #29 review P2-D).
      readonlyHint: part('[data-testid="execution-readonly-hint"]'),
      approvalOutcome: part('[data-testid="execution-approval-outcome"]'),
      otherSession: part('[data-testid="execution-other-session"]'),
      steps: part('[data-testid="execution-steps"]'),
      cardText: (card?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160),
      // Only the execution card may review a request ([PiDock 18]/[19] have one
      // approval surface), and the composer height is the [UI 对齐 03] #27 budget.
      approvalSurfaces: document.querySelectorAll('[data-testid="execution-approval-preview"]').length,
      composerH: box(document.querySelector('[data-testid="task-composer"]')),
      // Everything else in the column that is not the card, the composer, the
      // session row or the message area: it charges the message budget without
      // being part of the execution card (see the 双档 floor in the log).
      extraChrome: [
        ...(document.querySelector('[data-testid="task-workspace"]')?.children ?? []),
      ]
        .filter(
          (child) =>
            !child.matches(
              '[data-testid="execution-card"], [data-testid="task-composer"], [data-testid="session-tab-strip"], [role="log"]',
            ),
        )
        .map((child) => ({
          label: child.getAttribute("data-testid") ?? `${child.tagName.toLowerCase()}${(child.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24)}`,
          h: box(child),
        })),
      draftReferencesH: box(document.querySelector('[data-testid="task-composer"] ul')),
    };
  });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { renderer: RENDERER, prototype: PROTOTYPE, tabStrip: {}, tabStripLongName: {}, card: {} };
await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

async function openPanels(page, panels) {
  // Panel keys, not labels: an evidence script must locate by `data-testid`, so a
  // copy change cannot stop a capture from re-running ([UI 对齐 06] #30 review).
  //
  // The tabs only exist once the rail is open, and the header launcher is the only
  // entry point that opens it: clicking `tool-tab-*` first found nothing and made
  // every "with the tool rail" tier a silent copy of the closed one ([UI 对齐 06]
  // #30 review P1-1). The launcher toggles, so it is clicked only while its panel
  // is closed (`aria-pressed`).
  for (const panel of panels) {
    const launcher = page.getByTestId(`tool-launcher-${panel}`);
    if ((await launcher.count()) === 0) continue;
    if ((await launcher.first().getAttribute("aria-pressed")) !== "true") {
      await launcher.first().click();
      await page.waitForTimeout(120);
    }
  }
  if (panels.length > 0) {
    const rail = page.getByTestId("task-rail");
    await rail.waitFor({ timeout: 5000 });
    const tab = page.getByTestId(`tool-tab-${panels[panels.length - 1]}`);
    if ((await tab.count()) > 0) {
      await tab.first().click();
      await page.waitForTimeout(120);
    }
    const open = await page.getByTestId("task-rail").count();
    if (open === 0) throw new Error("openPanels: the tool rail did not open");
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

// -------------------------------------------- tab strip: long name + tool rail
//
// [UI 对齐 05] (#29) review P2-2/P2-B: at 1181-1277px with the tool rail open the
// strip has ~360-410px, and a 10-character session name is the longest a tab label
// gets (`sessionTabLabel`). Prototype A's `navigation.css` keeps
// `.session-tabs{overflow:hidden}` with `.session-tab{min-width:0;max-width:180px;
// overflow:hidden;text-overflow:ellipsis}` and only the surrounding `.sessions` row
// scrolls, so a crowded prototype row ellipsizes its tabs. This implementation
// deliberately deviates: the tab list itself scrolls and the 10-character cap
// (≈142px < the prototype's 180px) means no label is cut. This sweep is the check
// that no label is cut and the active tab stays reachable at every tier.
for (const width of LONG_NAME_VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.getByTestId("session-new").click();
  await page.waitForTimeout(300);
  const newest = page.locator('[data-testid^="session-tab-"]:not([data-testid="session-tab-strip"])').last();
  await newest.click({ button: "right" });
  await page.getByTestId("session-menu-rename").click();
  await page.getByTestId("session-name-input").fill(LONG_NAME);
  await page.getByTestId("session-name-save").click();
  await page.waitForTimeout(200);
  // The closed row is measured with the same long name, so the pair shows what the
  // rail costs the strip instead of trusting the rail to have opened (P1-1).
  report.tabStripLongName[`${width}x900-closed`] = { ...(await measureTabs(page)), sessionName: LONG_NAME };
  await openPanels(page, [ALL_PANELS[3]]);
  const measured = { ...(await measureTabs(page)), sessionName: LONG_NAME };
  report.tabStripLongName[`${width}x900-rail`] = measured;
  await page.screenshot({ path: `${OUT}/renderer/${width}x900-tabs-longname-rail.png` });
  console.log(
    `long name ${width}: strip=${measured.strip?.clientWidth}/${measured.strip?.scrollWidth} ` +
      `railOpen=${measured.railOpen} railW=${measured.railW} ` +
      `truncated=${measured.tabs.filter((tab) => tab.labelClipped).map((tab) => tab.text).join(",") || "none"} ` +
      `activeInside=${measured.tabs.find((tab) => tab.active)?.insideStrip}`,
  );
  await context.close();
}

// ------------------------------------------------------------ execution card
//
// Every state is driven through the real UI (the seeded release task has two
// pending confirmations on 部署审查 and a scripted failing session), so the
// screenshots show the same card a user would see. The read-only variant is reached
// by driving a real failure first and then switching that session to 只读 through
// its own permission dialog (P2-D).
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
  const input = page.getByTestId("task-composer-input");
  await input.click();
  await input.fill(text);
  await page.getByTestId("composer-send").click();
};

const expirePending = async (page) => {
  const button = page.getByTestId("execution-approval-expire");
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
  await page.getByTestId("execution-action-reject").first().click();
  await page.waitForTimeout(300);
  await page.getByTestId("execution-action-approve").first().click();
  await page.waitForTimeout(300);
  return "批准第二条待确认请求后进入执行中（会话 runState=running）";
});

await capture("stopped", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("execution-action-reject").first().click();
  await page.waitForTimeout(300);
  await page.getByTestId("execution-action-approve").first().click();
  await page.waitForTimeout(300);
  await page.getByTestId("execution-action-stop").first().click();
  await page.waitForTimeout(400);
  return "停止执行走既有 stopRun；卡片回到已停止且不再提供入口";
});

await capture("rejected", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("execution-action-reject").first().click();
  await page.waitForTimeout(300);
  await page.getByTestId("execution-action-reject").first().click();
  await page.waitForTimeout(400);
  return "两条请求都拒绝后会话落到已拒绝";
});

await capture("expired", async (page) => {
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // 标记过期 lives in the execution card, which reviews whichever request is
  // pending: the seeded session has two, so two expiries reach 确认已过期. (Before
  // [UI 对齐 05] (#29) this state was only reachable from jsdom, because the
  // second request had no expiry entry anywhere in the UI.)
  await expirePending(page);
  await expirePending(page);
  await page.waitForTimeout(400);
  return "两条待确认请求都过期后：执行状态卡落在确认已过期（标记过期为演示入口，真实调度由 Host 承担）";
});

await capture("failed", async (page) => {
  await page.goto(task("release", "failed"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await sendToComposer(page, "修复构建并重试");
  await page.getByTestId("execution-action-retry").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(200);
  return "失败排查会话的真实失败回合：失败范围 + 折叠的步骤";
});

await capture("failed-readonly", async (page) => {
  // [UI 对齐 05] (#29) review P2-D: the read-only rule is a visible element, and
  // no other state measured it while a record is on screen. The seed data cannot
  // reach it (the read-only session has no run), so the failing session is driven
  // into a failure first and then switched to 只读 through its own permission
  // dialog — the same route a user takes.
  await page.goto(task("release", "failed"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await sendToComposer(page, "修复构建并重试");
  await page.getByTestId("execution-action-retry").first().waitFor({ timeout: 15000 });
  await page.getByTestId("composer-permission").click();
  await page.getByTestId("permission-read").click();
  await page.waitForTimeout(300);
  return "只读会话 + 真实失败记录：入口禁用，可见说明行在状态行内，不改卡片高度";
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
        // The comparison the 340px floor is judged against: prototype A's own
        // message area with its waiting panel on screen.
        messagesH: box(".messages"),
        composerH: box(".composer-wrap"),
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
const CARD_GUARDRAIL = 145;

function assertGeometry(measured) {
  const violations = [];
  const checkStrip = (key, value, expectVisibleCount) => {
    if (value.strip && value.strip.clipPx > 0 && value.scrollable !== true) {
      violations.push(`${key}: tab strip clips by ${value.strip.clipPx}px without a scroll`);
    }
    for (const tab of value.tabs) if (tab.labelClipped) violations.push(`${key}: label of ${tab.id} is truncated`);
    if (value.noHorizontalOverflow !== true) violations.push(`${key}: page overflows horizontally`);
    const active = value.tabs.find((tab) => tab.active);
    if (!active) violations.push(`${key}: no active tab`);
    else if (active.insideStrip !== true) violations.push(`${key}: the active tab is outside the strip`);
    if (expectVisibleCount !== null) {
      const width = Number(key.split("x")[0]);
      const expected = width > 1180 ? 4 : width > 960 ? 2 : 1;
      if (value.visibleTabs !== expected) violations.push(`${key}: expected ${expected} visible tabs, measured ${value.visibleTabs}`);
    }
  };
  for (const [key, value] of Object.entries(measured.tabStrip)) checkStrip(key, value, true);
  // Anti-no-op guard ([UI 对齐 06] #30 review P1-1): a tier that claims the tool
  // rail is open has to show the rail *and* account for where it went. Above 720px
  // it sits beside the conversation and the strip has to be strictly narrower than
  // the same viewport with the rail closed. At ≤720px prototype A stacks the rail
  // under the conversation (`.taskblock{display:block}` / `.workbench{width:100%}`),
  // so an unchanged strip is the correct result there — the rail is proven open by
  // `railOpen`/`railW` instead. Without this guard a launcher that stopped working
  // turned the tier into a copy of `closed` while the JSON still said `railOpen`.
  const railAccounts = (key, value, closed) => {
    if (value.railOpen !== true || value.railW <= 0) {
      return `${key}: claims an open tool rail, but railOpen=${value.railOpen} railW=${value.railW}`;
    }
    if (!closed) return null;
    if (value.strip.clientWidth < closed.strip.clientWidth) return null;
    if (value.viewport.w <= 720) return null;
    return `${key}: strip ${value.strip.clientWidth}px is not narrower than the closed tier's ${closed.strip.clientWidth}px (the rail never opened)`;
  };
  for (const [key, value] of Object.entries(measured.tabStrip)) {
    if (key.endsWith("-closed")) continue;
    const message = railAccounts(key, value, measured.tabStrip[`${key.split("-")[0]}-closed`]);
    if (message) violations.push(message);
  }
  for (const [key, value] of Object.entries(measured.tabStrip)) {
    if (value.addButton === null || value.addButton.visible !== true) violations.push(`${key}: the new-session entry is missing`);
  }
  // The long-name sweep keeps whatever the tier shows: the point is that no
  // label is cut and the active tab is reachable (P2-2).
  for (const [key, value] of Object.entries(measured.tabStripLongName)) {
    checkStrip(key, value, null);
    if (value.tabs.filter((tab) => tab.visible).length < 2) violations.push(`${key}: the active session lost its neighbouring tab`);
    if (!key.endsWith("-rail")) continue;
    const message = railAccounts(key, value, measured.tabStripLongName[key.replace("-rail", "-closed")]);
    if (message) violations.push(message);
  }
  for (const [name, state] of Object.entries(measured.card)) {
    if (state.cardPresent && state.cardScrolls) violations.push(`${name}: card scrolls inside its max-height`);
    if (state.noHorizontalOverflow !== true) violations.push(`${name}: page overflows horizontally`);
    if (state.approvalSurfaces > 1) violations.push(`${name}: ${state.approvalSurfaces} approval surfaces rendered`);
    // [UI 对齐 03] (#27) budget: 400px without an execution card. With a card the
    // floor is tiered (parent ruling on the [UI 对齐 05] (#29) review): 340px for
    // the states whose column only holds the card, 300px for the states that also
    // carry chrome outside this slice.
    const floor = ["approval", "expired"].includes(name) ? 340 : 300;
    if (state.cardPresent && ["approval", "running", "expired", "failed", "completed", "failed-readonly"].includes(name) && state.messagesH < floor) {
      violations.push(`${name}: message area ${state.messagesH}px < the ${floor}px floor for this state's chrome`);
    }
    if (state.cardPresent && state.cardH > CARD_GUARDRAIL) {
      violations.push(`${name}: card ${state.cardH}px > the ${CARD_GUARDRAIL}px guardrail`);
    }
    // The read-only rule has to stay visible *and* inside the guardrail: the hint
    // shares the state row instead of taking a block of its own (P2-D).
    if (name === "failed-readonly" && !(state.readonlyHint > 0)) {
      violations.push(`${name}: the read-only hint is not visible`);
    }
    if (name === "failed-readonly" && state.readonlyHint > 0 && state.readonlyHint > 40) {
      violations.push(`${name}: the read-only hint adds ${state.readonlyHint}px of its own`);
    }
    if (state.cardPresent && state.cardH > (measured.prototypeExecutionPanel?.waiting?.panelH ?? Infinity)) {
      violations.push(`${name}: card ${state.cardH}px is taller than the prototype's waiting panel`);
    }
  }
  for (const name of ["approval", "running", "expired", "failed", "completed", "failed-readonly"]) {
    if (!measured.card[name]) violations.push(`${name}: missing from the capture`);
  }
  // The long-name sweep has to keep its closed partner: it is what proves the rail
  // actually narrowed the strip (P1-1).
  for (const width of [1181, 1200, 1240, 1277, 1280, 1440]) {
    if (!measured.tabStripLongName[`${width}x900-closed`]) violations.push(`long-name sweep: ${width}px has no closed row to compare`);
  }
  if (violations.length > 0) throw new Error(`geometry assertions failed:\n- ${violations.join("\n- ")}`);
  return (
    Object.keys(measured.tabStrip).length + Object.keys(measured.tabStripLongName).length + Object.keys(measured.card).length
  );
}

await browser.close();
report.assertions = { checked: assertGeometry(report), violations: 0 };
await writeFile(`${OUT}/execution-card.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log("--- tab strip clipping (px over the box) ---");
for (const [key, value] of Object.entries(report.tabStrip)) {
  console.log(`${key}: clip=${value.strip?.clipPx} visibleTabs=${value.visibleTabs} labelClipped=${value.tabs.some((tab) => tab.labelClipped)} overflow=${!value.noHorizontalOverflow}`);
}
console.log("--- long name + tool rail (P2-2) ---");
for (const [key, value] of Object.entries(report.tabStripLongName)) {
  const truncated = value.tabs.filter((tab) => tab.labelClipped).map((tab) => tab.text);
  const active = value.tabs.find((tab) => tab.active);
  console.log(
    `${key}: strip=${value.strip?.clientWidth}/${value.strip?.scrollWidth} railOpen=${value.railOpen} railW=${value.railW} ` +
      `scrollable=${value.scrollable} truncated=${truncated.length === 0 ? "none" : truncated.join(",")} activeInsideStrip=${active?.insideStrip}`,
  );
}
console.log("--- execution card message area (px) ---");
for (const [name, state] of Object.entries(report.card)) {
  const floor = ["approval", "expired"].includes(name) ? 340 : state.cardPresent ? 300 : null;
  const chrome = state.extraChrome.map((item) => `${item.label}=${item.h}`).join("+") || "none";
  console.log(
    `${name}: state=${state.state} messages=${state.messagesH}${floor ? ` (floor ${floor})` : ""} card=${state.cardH} ` +
      `surfaces=${state.approvalSurfaces} composer=${state.composerH} chrome=${chrome}`,
  );
}
console.log(
  `prototype A waiting: messages=${report.prototypeExecutionPanel.waiting.messagesH} panel=${report.prototypeExecutionPanel.waiting.panelH} ` +
    `composer=${report.prototypeExecutionPanel.waiting.composerH} (card guardrail ${CARD_GUARDRAIL}px)`,
);
console.log(`prototype panel: idle=${report.prototypeExecutionPanel.idle.panelH}px waiting=${report.prototypeExecutionPanel.waiting.panelH}px`);
console.log(`geometry assertions: ok (${report.assertions.checked} measured states)`);
console.log(`wrote ${OUT}/execution-card.json`);
