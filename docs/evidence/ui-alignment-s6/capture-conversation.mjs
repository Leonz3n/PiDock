// [UI 对齐 07] (#31) conversation + references evidence.
//
// jsdom has no layout, so the slice's claims are measured in headless Chromium:
// the message chrome (`.messages` padding, `.message` rhythm, `.message-head`,
// `.userbubble` geometry), the `.refchip` reference form, the run-result card
// (`.toolcard`) and the `.session-subagents` band. Each measured property is
// compared against the same property read from prototype A in the same run, so a
// drifted value fails here instead of in review. The subagent band also carries
// the [UI 对齐 05] (#29) residual: it used to cost the conversation a permanent
// 78px (the #29 evidence measured 349px of message area at 1440x900 with a
// 53px card); this script asserts the band is back under 55px and the message
// area grew by at least 25px against that committed baseline.
//
//   node docs/evidence/ui-alignment-s6/capture-conversation.mjs
//
// Images and JSON are written next to this file so the evidence stays
// reproducible from the repository (same convention as `ui-alignment-s1/s2/s3/s5`).
// Every locator is a `data-testid` (the [UI 对齐 06] #30 lesson: an evidence
// script keyed on an accessible name breaks the moment the name is aligned).

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** The #29 evidence (commit 3f20369) measured this message area at 1440x900. */
const S3_MESSAGES_BASELINE = 349;
/** [UI 对齐 03] (#27) floor for a conversation with no execution card. */
const MESSAGES_FLOOR_NO_CARD = 400;
/** [UI 对齐 05] (#29) parent ruling: the floor when this slice's own chrome is absent. */
const MESSAGES_FLOOR_CARD = 300;
/** The band the #29 review listed as squeezing the conversation. */
const SUBAGENT_BAND_BEFORE = 78;
const SUBAGENT_BAND_TARGET = 55;

// `below-wide` is `@media (max-width:1180px)` and `below-mid` is
// `(max-width:960px)`, so 1180px already owns the 20px tier and the 31px indent
// drops at 960px — the same boundary the prototype's `style.css` uses.
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900, pad: "26px 28px 10px", indent: 31, floor: true },
  { name: "1280x900", width: 1280, height: 900, pad: "26px 28px 10px", indent: 31, floor: false },
  { name: "1180x900", width: 1180, height: 900, pad: "20px", indent: 31, floor: false },
  { name: "1024x800", width: 1024, height: 800, pad: "20px", indent: 31, floor: false },
  { name: "900x800", width: 900, height: 800, pad: "16px", indent: 0, floor: false },
];

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
  "base64",
);

const report = {
  slice: "[UI 对齐 07] #31",
  baseline: { s3MessagesH: S3_MESSAGES_BASELINE, subagentBandH: SUBAGENT_BAND_BEFORE },
  prototypeA: {},
  viewports: {},
  subagents: {},
  toolCard: {},
  empty: {},
  readOnly: {},
  referenceMessage: {},
  assertions: { checked: 0, violations: [] },
};

const check = (label, ok, detail) => {
  report.assertions.checked += 1;
  if (!ok) report.assertions.violations.push(`${label}: ${detail}`);
  return ok;
};

const chrome = await chromium.launch({ executablePath: CHROME });

// -------------------------------------------------------- prototype reference
//
// Read the same properties off prototype A, so "aligns with the prototype" is a
// measured equality rather than a claim in a comment.
const prototype = await chrome.newPage({ viewport: { width: 1440, height: 900 } });
await prototype.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
await prototype.waitForTimeout(400);
report.prototypeA = await prototype.evaluate(() => {
  const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
  const style = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const computed = getComputedStyle(element);
    return {
      padding: computed.padding,
      fontSize: computed.fontSize,
      gap: computed.gap,
      marginBottom: computed.marginBottom,
      marginLeft: computed.marginLeft,
      backgroundColor: computed.backgroundColor,
      borderTopLeftRadius: computed.borderTopLeftRadius,
      borderTopRightRadius: computed.borderTopRightRadius,
      borderBottomLeftRadius: computed.borderBottomLeftRadius,
      border: computed.borderWidth,
      gridTemplateColumns: computed.gridTemplateColumns,
    };
  };
  return {
    messages: style(".messages"),
    messagesH: box(document.querySelector(".messages")),
    message: style(".message"),
    messageHead: style(".message-head"),
    userbubble: style(".userbubble"),
    agentbody: style(".agentbody"),
    refchip: style(".refchip"),
    dateLabel: style(".date-label"),
    messageFooter: style(".message-footer"),
    toolcard: style(".toolcard"),
    toolrow: style(".toolrow"),
    steps: style(".steps"),
    runResult: style(".run-result"),
    sessionSubagents: style(".session-subagents"),
    subagentCards: style(".subagent-cards"),
    subagentCard: style(".subagent-card"),
    brandmarkH: box(document.querySelector(".message-head .brandmark")),
    avatarH: box(document.querySelector(".message-head .avatar")),
    dateLabelText: document.querySelector(".date-label")?.textContent?.trim() ?? null,
    toolcardPresent: document.querySelector(".toolcard") !== null,
  };
});
await prototype.screenshot({ path: `${OUT}/prototype/1440x900-conversation.png` });
await prototype.close();

await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

const measureConversation = (page) =>
  page.evaluate(() => {
    const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        padding: computed.padding,
        fontSize: computed.fontSize,
        gap: computed.gap,
        marginBottom: computed.marginBottom,
        marginLeft: computed.marginLeft,
        backgroundColor: computed.backgroundColor,
        borderTopLeftRadius: computed.borderTopLeftRadius,
        borderTopRightRadius: computed.borderTopRightRadius,
        borderBottomLeftRadius: computed.borderBottomLeftRadius,
        border: computed.borderWidth,
        gridTemplateColumns: computed.gridTemplateColumns,
      };
    };
    const log = document.querySelector('[data-testid="conversation-log"]');
    const card = document.querySelector('[data-testid="tool-result-card"]');
    const band = document.querySelector('[data-testid="session-subagents"]');
    const cards = document.querySelector('[data-testid="subagent-cards"]');
    const userMessage = document.querySelector('[data-testid="message-head"] [data-testid="message-avatar"]')?.closest("li");
    const agentMessage = document.querySelector('[data-testid="message-head"] [data-testid="message-brandmark"]')?.closest("li");
    return {
      viewport: { w: innerWidth, h: innerHeight },
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      messagesH: box(log),
      messagesHShare: log ? Number((log.getBoundingClientRect().height / innerHeight).toFixed(3)) : null,
      messages: style('[data-testid="conversation-log"]'),
      message: style('[data-testid="conversation-group"] li'),
      messageHead: style('[data-testid="message-head"]'),
      userbubble: userMessage ? style(`[data-testid="message-${userMessage.dataset.testid.slice("message-".length)}"] [data-testid="message-body"]`) : null,
      userbubbleBody: userMessage
        ? (() => {
            const body = userMessage.querySelector('[data-testid="message-body"]');
            if (!body) return null;
            const computed = getComputedStyle(body);
            return {
              padding: computed.padding,
              marginLeft: computed.marginLeft,
              backgroundColor: computed.backgroundColor,
              borderTopLeftRadius: computed.borderTopLeftRadius,
              borderTopRightRadius: computed.borderTopRightRadius,
              borderBottomLeftRadius: computed.borderBottomLeftRadius,
            };
          })()
        : null,
      agentBody: agentMessage
        ? (() => {
            const body = agentMessage.querySelector('[data-testid="message-body"]');
            if (!body) return null;
            const computed = getComputedStyle(body);
            return { marginLeft: computed.marginLeft };
          })()
        : null,
      dateLabel: style('[data-testid="conversation-date-label"]'),
      dateLabelText: document.querySelector('[data-testid="conversation-date-label"]')?.textContent?.trim() ?? null,
      groupCount: document.querySelectorAll('[data-testid="conversation-group"]').length,
      messageCount: document.querySelectorAll('[data-testid^="message-m-"], [data-testid^="message-msg-"]').length,
      brandmarkH: box(document.querySelector('[data-testid="message-brandmark"]')),
      avatarH: box(document.querySelector('[data-testid="message-avatar"]')),
      modeLabel: document.querySelector('[data-testid="message-mode"]')?.textContent?.trim() ?? null,
      stateBadge: document.querySelector('[data-testid="message-state-badge"]')?.textContent?.trim() ?? null,
      headTime: document.querySelector('[data-testid="message-time"]')?.textContent?.trim() ?? null,
      refchip: style('[data-testid^="message-refchip-"]'),
      refchipText: document.querySelector('[data-testid^="message-refchip-"]')?.textContent?.trim() ?? null,
      imageCount: document.querySelectorAll('[data-testid^="message-image-"]').length,
      // Prototype `.message-images img{width:200px;height:125px;object-fit:contain}`.
      imageBox: (() => {
        const image = document.querySelector('[data-testid^="message-image-"] img');
        if (!image) return null;
        const rect = image.getBoundingClientRect();
        const computed = getComputedStyle(image);
        return {
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          objectFit: computed.objectFit,
          background: computed.backgroundColor,
          radius: computed.borderTopLeftRadius,
        };
      })(),
      footer: style('[data-testid="message-footer"]'),
      footerText: document.querySelector('[data-testid="message-footer"]')?.textContent?.trim() ?? null,
      toolCard: card
        ? {
            h: box(card),
            insideLog: log ? log.contains(card) : null,
            rows: [...card.querySelectorAll('[data-testid^="tool-result-row-"]')].map((row) => row.textContent.trim()),
            steps: [...card.querySelectorAll('[data-testid^="tool-result-step-"]')].map((step) => ({
              text: step.textContent.trim(),
              // The prototype marks the step a running turn is on with `.dot.live`.
              live: step.querySelector("span")?.className.includes("bg-accent") ?? false,
            })),
            summary: card.querySelector('[data-testid="tool-result-summary"]')?.textContent?.trim() ?? null,
            actions: [...card.querySelectorAll("button")].map((button) => button.textContent.trim()),
          }
        : null,
      cards: cards ? { h: box(cards), gridTemplateColumns: getComputedStyle(cards).gridTemplateColumns, cardH: box(cards.querySelector("button")) } : null,
      card: cards ? style('[data-testid="subagent-cards"] button') : null,
      cardLabels: [...document.querySelectorAll('[data-testid="subagent-cards"] button')].map((button) => ({
        label: button.getAttribute("aria-label"),
        pressed: button.getAttribute("aria-pressed"),
        live: button.querySelector("span span")?.className.includes("bg-accent") ?? false,
      })),
      band: band
        ? {
            h: box(band),
            padding: getComputedStyle(band).padding,
            toggle: band.querySelector('[data-testid="session-subagents-toggle"]')?.textContent?.trim() ?? null,
            expanded: band.querySelector('[data-testid="session-subagents-toggle"]')?.getAttribute("aria-expanded") ?? null,
            summary: band.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
          }
        : null,
      executionCard: document.querySelector('[data-testid="execution-card"]')
        ? {
            h: box(document.querySelector('[data-testid="execution-card"]')),
            state: document.querySelector('[data-testid="execution-card-state"]')?.textContent?.trim() ?? null,
          }
        : null,
      empty: document.querySelector('[data-testid="conversation-empty"]')
        ? {
            present: true,
            h: box(document.querySelector('[data-testid="conversation-empty"]')),
            text: document.querySelector('[data-testid="conversation-empty"]').textContent.replace(/\s+/g, " ").trim(),
            brandmark: document.querySelector('[data-testid="conversation-empty"] [data-testid="message-brandmark"]') !== null,
          }
        : { present: false },
    };
  });

const sendToComposer = async (page, text) => {
  const input = page.getByTestId("task-composer-input");
  await input.click();
  await input.fill(text);
  await page.getByTestId("composer-send").click();
};

const withPage = async (width, height, fn) => {
  const context = await chrome.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
};

// ---------------------------------------------------------- tier sweep
//
// The three tiers of `style.css`: `.messages{padding:26px 28px 10px}`, `20px`
// below 1180px, `16px` below 960px, and the 31px body indent that drops to 0 at
// the same 960px tier.
for (const viewport of VIEWPORTS) {
  await withPage(viewport.width, viewport.height, async (page) => {
    await page.goto(task("release", "main"), { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const measured = await measureConversation(page);
    report.viewports[viewport.name] = measured;
    await page.screenshot({ path: `${OUT}/renderer/${viewport.name}-conversation.png` });
    check(`pad ${viewport.name}`, measured.messages?.padding === viewport.pad, `padding ${measured.messages?.padding} != ${viewport.pad}`);
    check(`indent ${viewport.name}`, measured.userbubbleBody?.marginLeft === `${viewport.indent}px`, `indent ${measured.userbubbleBody?.marginLeft} != ${viewport.indent}px`);
    check(`agent indent ${viewport.name}`, measured.agentBody?.marginLeft === `${viewport.indent}px`, `agent indent ${measured.agentBody?.marginLeft} != ${viewport.indent}px`);
    check(`no overflow ${viewport.name}`, measured.noHorizontalOverflow === true, "document overflows horizontally");
    // The two floors are viewport-specific: the [UI 对齐 03] (#27) 400px baseline
    // was measured at 1440x900 with no execution card, and the [UI 对齐 05] (#29)
    // 300px floor covers a conversation that also carries the execution card. A
    // shorter window (800px) is not the state either number was derived from.
    if (viewport.floor) {
      const floor = measured.executionCard === null ? MESSAGES_FLOOR_NO_CARD : MESSAGES_FLOOR_CARD;
      check(`floor ${viewport.name}`, (measured.messagesH ?? 0) >= floor, `message area ${measured.messagesH}px < ${floor}px`);
    }
    if (measured.executionCard !== null) report.viewports[`${viewport.name}-executionCard`] = measured.executionCard;
    console.log(
      `viewport ${viewport.name}: pad=${measured.messages?.padding} indent=${measured.userbubbleBody?.marginLeft} ` +
        `messages=${measured.messagesH} band=${measured.band?.h} date=${measured.dateLabelText} mode=${measured.modeLabel} badge=${measured.stateBadge}`,
    );
  });
}

// ------------------------------------------------- prototype equality
//
// Same property, same viewport, both sides measured in this run.
await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const mine = await measureConversation(page);
  const prototypeA = report.prototypeA;
  const pairs = [
    ["messages padding", mine.messages?.padding, prototypeA.messages?.padding],
    ["message margin-bottom", mine.message?.marginBottom, prototypeA.message?.marginBottom],
    ["message-head gap", mine.messageHead?.gap, prototypeA.messageHead?.gap],
    ["message-head font", mine.messageHead?.fontSize, prototypeA.messageHead?.fontSize],
    ["userbubble padding", mine.userbubbleBody?.padding, prototypeA.userbubble?.padding],
    ["userbubble background", mine.userbubbleBody?.backgroundColor, prototypeA.userbubble?.backgroundColor],
    ["userbubble top-left radius", mine.userbubbleBody?.borderTopLeftRadius, prototypeA.userbubble?.borderTopLeftRadius],
    ["userbubble top-right radius", mine.userbubbleBody?.borderTopRightRadius, prototypeA.userbubble?.borderTopRightRadius],
    ["brandmark height", `${mine.brandmarkH}px`, `${prototypeA.brandmarkH}px`],
    ["avatar height", `${mine.avatarH}px`, `${prototypeA.avatarH}px`],
    ["date-label font", mine.dateLabel?.fontSize, prototypeA.dateLabel?.fontSize],
  ];
  report.prototypeEquality = pairs.map(([label, actual, expected]) => ({ label, actual, expected, equal: actual === expected }));
  for (const pair of report.prototypeEquality) {
    check(`prototype ${pair.label}`, pair.equal, `${pair.actual} != ${pair.expected}`);
    console.log(`prototype ${pair.label}: ${pair.actual} vs ${pair.expected} ${pair.equal ? "ok" : "MISMATCH"}`);
  }
});

// ------------------------------------------------------------ subagent band
for (const [name, width, height] of [
  ["1440x900", 1440, 900],
  ["900x800", 900, 800],
]) {
  await withPage(width, height, async (page) => {
    await page.goto(task("release", "main"), { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const collapsed = await measureConversation(page);
    await page.getByTestId("session-subagents-toggle").click();
    await page.waitForTimeout(250);
    const expanded = await measureConversation(page);
    const columns = (expanded.cards?.gridTemplateColumns ?? "").split(" ").filter((value) => value !== "0px" && value.length > 0).length;
    report.subagents[name] = {
      collapsed: { bandH: collapsed.band?.h, messagesH: collapsed.messagesH, padding: collapsed.band?.padding, summary: collapsed.band?.summary },
      expanded: {
        bandH: expanded.band?.h,
        messagesH: expanded.messagesH,
        padding: expanded.band?.padding,
        gridTemplateColumns: expanded.cards?.gridTemplateColumns,
        columns,
        cardH: expanded.cards?.cardH,
        cardPadding: expanded.card?.padding,
        labels: expanded.cardLabels,
      },
    };
    await page.screenshot({ path: `${OUT}/renderer/${name}-subagents-expanded.png` });
    check(`band padding ${name}`, collapsed.band?.padding === (width <= 960 ? "11px 16px" : "12px 20px"), `padding ${collapsed.band?.padding}`);
    check(`band target ${name}`, (collapsed.band?.h ?? 999) <= SUBAGENT_BAND_TARGET, `collapsed band ${collapsed.band?.h}px > ${SUBAGENT_BAND_TARGET}px`);
    check(`band delta ${name}`, (collapsed.band?.h ?? 0) < SUBAGENT_BAND_BEFORE, `collapsed band ${collapsed.band?.h}px is not below the ${SUBAGENT_BAND_BEFORE}px the #29 review measured`);
    check(`band grows on expand ${name}`, (expanded.band?.h ?? 0) > (collapsed.band?.h ?? 0), "expanding the disclosure must add the card grid");
    check(`card columns ${name}`, columns === (width <= 960 ? 1 : 2), `${columns} columns at ${width}px`);
    check(`card padding ${name}`, expanded.card?.padding === "10px 12px", `card padding ${expanded.card?.padding}`);
    check(`card labels ${name}`, expanded.cardLabels.length === 2 && expanded.cardLabels.every((item) => item.label?.startsWith("查看 ")), JSON.stringify(expanded.cardLabels));
    console.log(
      `subagents ${name}: collapsed=${collapsed.band?.h} expanded=${expanded.band?.h} columns=${columns} ` +
        `messages ${collapsed.messagesH} -> ${expanded.messagesH}`,
    );
  });
}

// The [UI 对齐 05] (#29) residual: the band is no longer a permanent 78px, so the
// message area must have grown against the committed baseline.
await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("session-subagents-toggle").click();
  await page.waitForTimeout(250);
  const withBand = await measureConversation(page);
  await page.getByTestId("session-subagents-toggle").click();
  await page.waitForTimeout(250);
  const withoutBand = await measureConversation(page);
  report.recovery = {
    bandBefore: SUBAGENT_BAND_BEFORE,
    bandCollapsed: withoutBand.band?.h,
    bandExpanded: withBand.band?.h,
    messagesBefore: S3_MESSAGES_BASELINE,
    messagesCollapsed: withoutBand.messagesH,
    messagesExpanded: withBand.messagesH,
  };
  check(
    "recovery vs #29 baseline",
    (withoutBand.messagesH ?? 0) >= S3_MESSAGES_BASELINE + 25,
    `message area ${withoutBand.messagesH}px did not grow by 25px from ${S3_MESSAGES_BASELINE}px`,
  );
  console.log(`recovery: band ${SUBAGENT_BAND_BEFORE} -> ${withoutBand.band?.h}px, messages ${S3_MESSAGES_BASELINE} -> ${withoutBand.messagesH}px`);
});

// ------------------------------------------------------------ tool card
//
// Every card state is reached by driving a real turn through the composer (the
// renderer only learns about a run from the Host's events), so the card shows
// the record the Host reported instead of a fixture.
await withPage(1440, 900, async (page) => {
  // A real turn settles in ~30ms, so the mid-flight state is captured by holding
  // the page clock: the turn's own `setTimeout` ticks only when this script
  // advances it, which turns "the step a running turn is on" into a state that
  // can be asserted instead of raced.
  await page.clock.install();
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.clock.runFor(600);
  const input = page.getByTestId("task-composer-input");
  await input.click();
  await input.fill("跑一次构建检查");
  await page.getByTestId("composer-send").click();
  await page.clock.runFor(8);
  const running = await measureConversation(page);
  report.toolCard.running = running.toolCard;
  // No screenshot of this frozen frame: Playwright's screenshot path advances an
  // installed clock (measured: `runFor(8)` holds 「执行中 · 正在执行」 across four
  // evaluate round-trips, and the next screenshot call flips the card to 已完成),
  // so the image would show a settled card while the log claims a running one. The
  // mid-flight state is locked by the assertions and the JSON instead, and the
  // stable half of the same dot — the `pending` step a finished turn keeps — is
  // photographed below (`1440x900-toolcard-completed.png`).
  await page.clock.runFor(2000);
  const completed = await measureConversation(page);
  report.toolCard.completed = completed.toolCard;
  report.toolCard.completedMessagesH = completed.messagesH;
  await page.screenshot({ path: `${OUT}/renderer/1440x900-toolcard-completed.png` });
  check("tool card appears after a run", running.toolCard !== null, "no card while the turn runs");
  check("tool card inside the log", running.toolCard?.insideLog === true, "the card must live in the scroll area, not above it");
  check("tool card rows", running.toolCard?.rows.length === 2, `rows ${JSON.stringify(running.toolCard?.rows)}`);
  check("tool card steps", (running.toolCard?.steps.length ?? 0) >= 2, `steps ${JSON.stringify(running.toolCard?.steps)}`);
  check("tool card live step", running.toolCard?.steps.some((step) => step.live) === true, `running steps ${JSON.stringify(running.toolCard?.steps)}`);
  check("tool card running summary", (running.toolCard?.summary ?? "").includes("执行中"), `summary ${running.toolCard?.summary}`);
  check("tool card row action", running.toolCard?.actions?.[0] === "查看文件 ↗", JSON.stringify(running.toolCard?.actions));
  check("tool card actions", JSON.stringify(running.toolCard?.actions?.slice(1)) === JSON.stringify(["查看浏览器", "查看变更"]), JSON.stringify(running.toolCard?.actions));
  check("tool card completed summary", (completed.toolCard?.summary ?? "").startsWith("✓ "), `summary ${completed.toolCard?.summary}`);
  // The stable half of the live dot: a finished turn still carries its `pending`
  // step, and that step is what `1440x900-toolcard-completed.png` photographs.
  const completedPending = (completed.toolCard?.steps ?? []).filter((step) => step.text.includes("等待"));
  check("tool card completed keeps a pending step", completedPending.length >= 1, JSON.stringify(completed.toolCard?.steps));
  check("tool card completed drops the live step", completedPending.length >= 1 && completed.toolCard?.steps.every((step) => step.live === false), JSON.stringify(completed.toolCard?.steps));
  // This capture is not one of the states the [UI 对齐 05] (#29) ruling sized: it
  // stacks the write-coordination band (114px), the child-agent band and a card
  // whose "another session is running" line makes it taller, so no floor from that
  // ruling describes it. Its measured height is recorded, and the floors are
  // re-asserted against the #29 evidence below, per state.
  report.toolCard.runningMessagesH = running.messagesH;
  console.log(`tool card running: ${JSON.stringify(running.toolCard?.steps)} messages=${running.messagesH}`);
  console.log(`tool card completed: ${completed.toolCard?.summary}`);
});

await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "failed"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await sendToComposer(page, "重新构建一次");
  await page.waitForTimeout(2500);
  const failed = await measureConversation(page);
  report.toolCard.failed = failed.toolCard;
  report.toolCard.failedMessagesH = failed.messagesH;
  await page.screenshot({ path: `${OUT}/renderer/1440x900-toolcard-failed.png` });
  check("tool card failed summary", (failed.toolCard?.summary ?? "").startsWith("✗ "), `summary ${failed.toolCard?.summary}`);
  check("tool card failed detail", (failed.toolCard?.summary ?? "").includes("失败范围"), `summary ${failed.toolCard?.summary}`);
  console.log(`tool card failed: ${failed.toolCard?.summary}`);
});

// --------------------------------------------------- references and images
await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // One text attachment (`.refchip`) and one image (`.message-images`): both ride
  // the composer's existing reference path.
  await page.getByTestId("composer-file-input").setInputFiles([
    { name: "spec.md", mimeType: "text/markdown", buffer: Buffer.from("# spec") },
    { name: "shot.png", mimeType: "image/png", buffer: PNG },
  ]);
  await page.waitForTimeout(200);
  await sendToComposer(page, "看下附件");
  await page.waitForTimeout(2500);
  const measured = await measureConversation(page);
  report.referenceMessage = measured;
  // The log stays pinned to the newest message; the reference message is the one
  // above it, so the shot scrolls to it instead of photographing the card again.
  await page.locator('[data-testid^="message-refchip-"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/renderer/1440x900-reference-message.png` });
  const prototypeRefchip = report.prototypeA.refchip;
  check("message refchip", (measured.refchipText ?? "").startsWith("@ "), `refchip text ${measured.refchipText}`);
  check("message refchip padding", measured.refchip?.padding === prototypeRefchip?.padding, `${measured.refchip?.padding} != ${prototypeRefchip?.padding}`);
  check("message refchip font", measured.refchip?.fontSize === prototypeRefchip?.fontSize, `${measured.refchip?.fontSize} != ${prototypeRefchip?.fontSize}`);
  check("message refchip radius", measured.refchip?.borderTopLeftRadius === prototypeRefchip?.borderTopLeftRadius, `${measured.refchip?.borderTopLeftRadius} != ${prototypeRefchip?.borderTopLeftRadius}`);
  check("message image", measured.imageCount >= 1, `image attachments ${measured.imageCount}`);
  // Prototype `.message-images img{width:200px;height:125px;object-fit:contain}`.
  check("message image box", measured.imageBox?.w === 200 && measured.imageBox?.h === 125, JSON.stringify(measured.imageBox));
  check("message image fit", measured.imageBox?.objectFit === "contain", `object-fit ${measured.imageBox?.objectFit}`);
  await page.locator('[data-testid^="message-image-"]').first().click();
  await page.waitForSelector('[data-testid="attachment-preview-image"]', { timeout: 4000 });
  check("message image preview", (await page.locator('[data-testid="attachment-preview-image"]').count()) === 1, "thumbnail did not open the lightbox");
  await page.screenshot({ path: `${OUT}/renderer/1440x900-reference-message-lightbox.png` });
  check("message footer", (measured.footerText ?? "").includes(" / "), `footer ${measured.footerText}`);
  console.log(`reference message: refchip=${measured.refchipText} images=${measured.imageCount} footer=${measured.footerText}`);
});

// ------------------------------------------------------------- empty state
await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("session-new").click();
  await page.waitForTimeout(400);
  const measured = await measureConversation(page);
  report.empty = measured.empty;
  await page.screenshot({ path: `${OUT}/renderer/1440x900-conversation-empty.png` });
  check("empty state present", measured.empty.present === true, "a new session must show the empty state");
  check("empty state brandmark", measured.empty.brandmark === true, "the empty state keeps the brand mark");
  check("empty state copy", (measured.empty.text ?? "").includes("准备好开始了") && (measured.empty.text ?? "").includes("或用 @ 引用当前任务代码"), `copy ${measured.empty.text}`);
  check("empty state hides messages", measured.messageCount === 0, `${measured.messageCount} message rows in an empty session`);
  console.log(`empty state: ${measured.empty.text}`);
});

// ------------------------------------------------------------ read-only mode
await withPage(1440, 900, async (page) => {
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  // 阅读与分析 / 只读 is reached through the session's own permission control, the
  // way a user gets there (the seeded read-only session has no messages to label).
  await page.getByTestId("composer-permission").click();
  await page.waitForTimeout(200);
  await page.getByTestId("permission-read").click();
  await page.waitForTimeout(400);
  const measured = await measureConversation(page);
  report.readOnly = {
    mode: measured.modeLabel,
    badge: measured.stateBadge,
    messages: measured.messageCount,
    executionCard: measured.executionCard,
  };
  await page.screenshot({ path: `${OUT}/renderer/1440x900-conversation-readonly.png` });
  check("read-only mode label", measured.modeLabel === "阅读与分析", `mode ${measured.modeLabel}`);
  check("read-only badge", measured.stateBadge === "只读", `badge ${measured.stateBadge}`);
  console.log(`read-only: mode=${measured.modeLabel} badge=${measured.stateBadge}`);
});

// --------------------------------------------- cross-slice floors ([UI 对齐 05] #29)
//
// The conversation is what the child-agent band and the new card sit next to, so
// this slice re-runs the #29 script and re-checks the ruling from that evidence
// rather than only its own numbers: 340px where the column holds a confirmation
// or an expiry, 300px in the states that also carry chrome from other slices.
const s3 = JSON.parse(await readFile(`${OUT}/../ui-alignment-s3/execution-card.json`, "utf8"));
const S3_FLOORS = {
  approval: 340,
  expired: 340,
  running: 300,
  failed: 300,
  "failed-readonly": 300,
  completed: 300,
  stopped: 300,
  rejected: 300,
  "idle-other-busy": 300,
};
report.s3CrossCheck = {};
for (const [state, floor] of Object.entries(S3_FLOORS)) {
  const measured = s3.card?.[state]?.messagesH ?? null;
  report.s3CrossCheck[state] = { messagesH: measured, floor, before: report.s3Before?.[state] ?? null };
  check(`#29 floor ${state}`, (measured ?? 0) >= floor, `message area ${measured}px < ${floor}px`);
  console.log(`${state}: messages=${measured} floor=${floor}`);
}
// The band recovery, measured against the value the #29 evidence committed
// (commit 3f20369): the collapse must have bought the conversation at least 25px.
const idle = s3.card?.["idle-other-busy"]?.messagesH ?? 0;
check("recovery in the #29 evidence", idle >= S3_MESSAGES_BASELINE + 25, `idle-other-busy ${idle}px < ${S3_MESSAGES_BASELINE + 25}px`);
console.log(`#29 evidence idle-other-busy: ${S3_MESSAGES_BASELINE}px before this slice -> ${idle}px`);

// ------------------------------------------------------------------- output
await writeFile(`${OUT}/conversation.json`, `${JSON.stringify(report, null, 2)}\n`);

await chrome.close();
console.log(`\ngeometry assertions: ${report.assertions.violations.length === 0 ? "ok" : "FAILED"} (${report.assertions.checked} checks)`);
for (const violation of report.assertions.violations) console.log(`  violation: ${violation}`);
console.log(`wrote ${OUT}/conversation.json`);
process.exit(report.assertions.violations.length === 0 ? 0 : 1);
