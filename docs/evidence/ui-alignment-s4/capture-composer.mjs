// [UI 对齐 06] (#30) composer + attachment evidence.
//
// jsdom has no layout, so the two geometry claims of the slice are measured in
// headless Chromium: the box keeps one height at every tier (the [UI 对齐 03]
// (#27) residual was a wrap jump to 179px at ≤1024/≤720), and the message area
// keeps the [UI 对齐 03] (#27) 400px floor in the card-free state while the
// [UI 对齐 05] (#29) tiered floors hold when an execution card is on screen.
// Prototype A is measured through the same viewports so the numbers can be
// compared instead of asserted from memory. Run with the renderer dev server on
// 4335 and the prototype on 4319:
//
//   node docs/evidence/ui-alignment-s4/capture-composer.mjs
//
// Images and JSON are written next to this file so the evidence stays
// reproducible from the repository (same convention as `ui-alignment-s1/s3/s5`).

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
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x900", width: 1280, height: 900 },
  { name: "1024x800", width: 1024, height: 800 },
  { name: "900x800", width: 900, height: 800 },
  { name: "720x760", width: 720, height: 760 },
];
// Prototype `.composer textarea{min-height:66px}` and `.composer .iconbtn{width:22px}`
// (the shared `.iconbtn` height is 28px); `.image-attachments{max-height:182px}`.
const TEXTAREA_MIN_H = 66;
const ATTACH_WIDTH = 22;
const ATTACH_HEIGHT = 28;
const STRIP_MAX_H = 182;
// Prototype `.composer-wrap{max-height:65%}` is the ceiling the composer may
// never exceed, so the conversation keeps its share of the column.
const COMPOSER_MAX_SHARE = 0.65;
// [UI 对齐 03] (#27) floor for the card-free state.
const MESSAGES_FLOOR_NO_CARD = 400;
// [UI 对齐 05] (#29) tiered floors when an execution card is on screen.
const CARD_FLOOR = { approval: 340, expired: 340, default: 300 };
// [UI 对齐 05] (#29) card height guardrail.
const CARD_GUARDRAIL = 145;

await mkdir(`${OUT}/renderer`, { recursive: true });
await mkdir(`${OUT}/prototype`, { recursive: true });

const report = { taskUrl: task("release", "main"), viewports: VIEWPORTS.map((v) => v.name), tiers: {}, prototype: {}, states: {} };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

const measureComposer = (page) =>
  page.evaluate(
    ({ textareaMin, attachWidth, attachHeight, stripMax }) => {
      const composer = document.querySelector('[data-testid="task-composer"]');
      const form = composer?.querySelector("form");
      // The box's button row is the last div of the form ([data-testid] marks
      // the composer itself; the row is the flex container under the textarea).
      const textarea = composer?.querySelector("textarea");
      const row = textarea ? textarea.nextElementSibling : null;
      const meta = composer?.querySelector('[data-testid="compose-meta"]');
      const attach = composer?.querySelector('[data-testid="composer-attach"]');
      const strip = composer?.querySelector('[data-testid="composer-attachments"]');
      const conversation = document.querySelector('[data-testid="task-workspace"] [role="log"]');
      const workspace = document.querySelector('[data-testid="task-workspace"]');
      const card = document.querySelector('[data-testid="execution-card"]');
      const box = (element) => (element ? Math.round(element.getBoundingClientRect().height) : null);
      const width = (element) => (element ? Math.round(element.getBoundingClientRect().width) : null);
      const workspaceBox = workspace?.getBoundingClientRect();
      const formBox = form?.getBoundingClientRect();
      return {
        composerH: box(composer),
        formH: box(form),
        formPadding: form ? getComputedStyle(form).padding : null,
        composerMaxH: composer ? getComputedStyle(composer).maxHeight : null,
        composerScrolls: composer ? composer.scrollHeight > composer.clientHeight : null,
        textareaH: box(textarea),
        textareaMinH: textarea ? getComputedStyle(textarea).minHeight : null,
        textareaMinOk: textarea ? textarea.getBoundingClientRect().height >= textareaMin - 1 : false,
        rowH: box(row),
        // More than a button line means the prototype's single `.compose-bottom`
        // line wrapped, which is what grew the composer to 179px before.
        rowWrapped: row ? row.getBoundingClientRect().height > 40 : null,
        metaH: box(meta),
        attach: attach ? { h: box(attach), w: width(attach) } : null,
        attachOk: attach ? box(attach) === attachHeight && width(attach) === attachWidth : false,
        // Prototype `.composer-wrap{padding:9px 20px 15px}`: the 20px side inset is
        // what the box shares with the meta row, and the shadow is `.composer`'s
        // own ([UI 对齐 06] #30 review P2-A).
        insetLeft: formBox && workspaceBox ? Math.round(formBox.left - workspaceBox.left) : null,
        insetRight: formBox && workspaceBox ? Math.round(workspaceBox.right - formBox.right) : null,
        formShadow: form ? getComputedStyle(form).boxShadow : null,
        metaGap: form && meta ? Math.round(meta.getBoundingClientRect().top - form.getBoundingClientRect().bottom) : null,
        strip: strip ? { h: box(strip), scrolls: strip.scrollHeight > strip.clientHeight } : null,
        stripCapped: strip ? box(strip) <= stripMax + 1 || strip.scrollHeight > strip.clientHeight : null,
        attachmentChips: document.querySelectorAll('[data-testid="composer-attachments"] li').length,
        workspaceH: box(workspace),
        messagesH: box(conversation),
        cardPresent: card !== null,
        cardH: box(card),
        rows: workspace ? [...workspace.children].map((child) => ({ kind: child.getAttribute("data-testid") ?? child.tagName.toLowerCase(), h: box(child) })) : [],
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        viewport: { w: innerWidth, h: innerHeight },
      };
    },
    { textareaMin: TEXTAREA_MIN_H, attachWidth: ATTACH_WIDTH, attachHeight: ATTACH_HEIGHT, stripMax: STRIP_MAX_H },
  );

// ------------------------------------------------------------- renderer tiers
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  report.tiers[vp.name] = await measureComposer(page);
  await page.screenshot({ path: `${OUT}/renderer/${vp.name}-composer.png` });
  // A page shot is not evidence of the box at 720x760 (the page is 2804px tall and
  // the composer is below the fold), so every tier also gets a crop ([UI 对齐 06]
  // #30 review P2-F).
  await page.getByTestId("task-composer").screenshot({ path: `${OUT}/renderer/${vp.name}-composer-crop.png` });
  await page.close();
}

// --------------------------------------------- prototype A through the same tiers
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  report.prototype[vp.name] = await page.evaluate(() => {
    const wrap = document.querySelector(".composer-wrap");
    const box = (selector) => {
      const element = document.querySelector(selector);
      return element ? Math.round(element.getBoundingClientRect().height) : null;
    };
    const attach = document.querySelector(".attach-button");
    return {
      composerH: box(".composer-wrap"),
      padding: wrap ? getComputedStyle(wrap).padding : null,
      boxH: box(".composer"),
      textareaH: box(".composer textarea"),
      textareaMinH: document.querySelector(".composer textarea") ? getComputedStyle(document.querySelector(".composer textarea")).minHeight : null,
      metaH: box(".compose-meta"),
      metaFontSize: document.querySelector(".compose-meta") ? getComputedStyle(document.querySelector(".compose-meta")).fontSize : null,
      attach: attach ? { h: Math.round(attach.getBoundingClientRect().height), w: Math.round(attach.getBoundingClientRect().width) } : null,
      inset: (() => {
        const box = document.querySelector(".composer")?.getBoundingClientRect();
        const messages = document.querySelector(".messages")?.getBoundingClientRect();
        return box && messages ? { left: Math.round(box.left - messages.left), right: Math.round(messages.right - box.right) } : null;
      })(),
      shadow: document.querySelector(".composer") ? getComputedStyle(document.querySelector(".composer")).boxShadow : null,
      metaGap: (() => {
        const box = document.querySelector(".composer")?.getBoundingClientRect();
        const meta = document.querySelector(".compose-meta")?.getBoundingClientRect();
        return box && meta ? Math.round(meta.top - box.bottom) : null;
      })(),
      messagesH: box(".messages"),
    };
  });
  await page.screenshot({ path: `${OUT}/prototype/${vp.name}-composer.png` });
  await page.close();
}

// ------------------------------------------------------ card-free reference state
// The [UI 对齐 03] (#27) 400px floor is measured in the state it was measured in:
// no execution card. The release task's card is the cross-session hint for the
// pending `deploy` approval, so the user route is to reject that request first.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "deploy"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("execution-action-reject").first().click();
  await page.waitForTimeout(300);
  await page.getByTestId("session-tab-main").click();
  await page.waitForTimeout(400);
  report.states.cardFree = await measureComposer(page);
  await page.screenshot({ path: `${OUT}/renderer/1440-card-free.png` });
  await page.close();
}

// ------------------------------------------------------------------- read only
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("composer-permission").click();
  await page.getByTestId("permission-read").click();
  await page.waitForTimeout(400);
  report.states.readOnly = {
    ...(await measureComposer(page)),
    textareaDisabled: await page.locator('[data-testid="task-composer-input"]').isDisabled(),
    attachDisabled: await page.locator('[data-testid="composer-attach"]').isDisabled(),
    fileInputDisabled: await page.locator('[data-testid="composer-file-input"]').isDisabled(),
    sendDisabled: await page.getByTestId("composer-send").isDisabled(),
    hint: (await page.locator('[data-testid="composer-readonly-hint"]').textContent())?.trim() ?? null,
    hintVisible: await page.locator('[data-testid="composer-readonly-hint"]').isVisible(),
  };
  await page.screenshot({ path: `${OUT}/renderer/1440-readonly.png` });
  await page.close();
}

// ------------------------------------------------------------------- paste
// A synthetic `ClipboardEvent` carrying a `DataTransfer` image: it drives the
// real handler and the real store, but not the OS clipboard pipeline (recorded
// as a residual in the log).
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  report.states.paste = await page.evaluate(async () => {
    const textarea = document.querySelector('[data-testid="task-composer-input"]');
    textarea.focus();
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const data = new DataTransfer();
    data.items.add(new File([png], "clip.png", { type: "image/png" }));
    data.setData("text/plain", "看这张截图");
    const notCancelled = textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chips = [...document.querySelectorAll('[data-testid="composer-attachments"] [data-testid="composer-attachment-open"]')];
    const composer = document.querySelector('[data-testid="task-composer"]');
    return {
      defaultPrevented: !notCancelled,
      attachmentLabels: chips.map((chip) => chip.textContent.trim()),
      attachmentDetail: chips[0]?.getAttribute("title") ?? null,
      draftText: textarea.value,
      toast: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent.trim()).find((text) => text.startsWith("已粘贴")) ?? null,
      composerH: Math.round(composer.getBoundingClientRect().height),
    };
  });
  await page.screenshot({ path: `${OUT}/renderer/1440-paste.png` });
  // The chip opens the prototype's lightbox (`attachments.js` uses `modal()`), so
  // the open state is captured too instead of only asserted in jsdom ([UI 对齐 06]
  // #30 review P2-5).
  await page.getByTestId("composer-attachment-open").first().click();
  await page.waitForTimeout(300);
  report.states.pasteLightbox = {
    dialogRole: await page.locator('[data-testid="attachment-preview-image"]').evaluate((node) => node.closest('[role="dialog"]') !== null),
    imagePresent: await page.getByTestId("attachment-preview-image").isVisible(),
    detail: await page.getByTestId("attachment-preview-detail").textContent(),
  };
  await page.screenshot({ path: `${OUT}/renderer/1440-attachment-lightbox.png` });
  await page.close();
}

// ----------------------------------------------- unsupported image + warning
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByTestId("composer-model-trigger").click();
  // Model id, not its label: the picker rows carry a testid so the capture keeps
  // working when a display name changes ([UI 对齐 06] #30 closing round P2-1).
  await page.getByTestId("model-choice-本地 Qwen").click();
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const textarea = document.querySelector('[data-testid="task-composer-input"]');
    textarea.focus();
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from([137, 80, 78, 71])], "clip.png", { type: "image/png" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await page.waitForTimeout(300);
  report.states.unsupportedImage = {
    ...(await measureComposer(page)),
    warning: (await page.getByTestId("composer-image-warning").textContent())?.trim() ?? null,
    warningRole: await page.getByTestId("composer-image-warning").evaluate((node) => node.closest("p")?.getAttribute("role") ?? null),
    inlineModelEntry: await page.getByTestId("composer-image-warning-model").count(),
    sendDisabled: await page.getByTestId("composer-send").isDisabled(),
    attachmentsKept: await page.locator('[data-testid="composer-attachments"] li').count(),
  };
  await page.screenshot({ path: `${OUT}/renderer/1440-warning.png` });
  await page.close();
}

// -------------------------------------------------------------- heavy attachments
{
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `shot-${index}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`file ${index}`),
  }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "main"), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.locator('[data-testid="composer-file-input"]').setInputFiles(files);
  await page.waitForTimeout(400);
  report.states.heavyAttachments = await measureComposer(page);
  await page.screenshot({ path: `${OUT}/renderer/1440-heavy.png` });
  await page.close();

  // Prototype A under the same input, so "not worse than the prototype" is a
  // measured claim rather than an assumption.
  const prototype = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await prototype.goto(`${PROTOTYPE}/?variant=A`, { waitUntil: "networkidle" });
  await prototype.waitForTimeout(500);
  await prototype.setInputFiles("#attachment-picker", files);
  await prototype.waitForTimeout(400);
  report.states.heavyAttachmentsPrototype = await prototype.evaluate(() => {
    const wrap = document.querySelector(".composer-wrap");
    return {
      composerH: Math.round(wrap.getBoundingClientRect().height),
      messagesH: Math.round(document.querySelector(".messages").getBoundingClientRect().height),
    };
  });
  await prototype.screenshot({ path: `${OUT}/prototype/1440-heavy.png` });
  await prototype.close();
}

// ----------------------------------------------------------- execution-card states
// [UI 对齐 05] (#29) ruled the message-area floors for the states whose column
// carries an execution card; this slice's composer markup changed that column, so
// the same states are re-measured here instead of trusted ([UI 对齐 06] #30 review
// P1-1/P2-E). The authoritative assertion still lives in the [UI 对齐 05] (#29)
// capture; this sweep is what makes the #30 numbers reviewable.
const CARD_STATES = [
  { name: "approval", floor: CARD_FLOOR.approval, where: "deploy", note: "等待确认（卡内唯一审批面）" },
  { name: "failed", floor: CARD_FLOOR.default, where: "failed", note: "失败回合后的记录卡" },
];
{
  for (const spec of CARD_STATES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(task("release", spec.where), { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    if (spec.where === "failed") {
      await page.getByTestId("task-composer-input").fill("修复构建并重试");
      await page.getByTestId("composer-send").click();
      await page.getByTestId("execution-action-retry").first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(300);
    }
    report.states[`card-${spec.name}`] = { ...(await measureComposer(page)), note: spec.note, floor: spec.floor };
    await page.screenshot({ path: `${OUT}/renderer/1440-card-${spec.name}.png` });
    await page.close();
  }

  // 只读 + 记录：the state where the composer used to repeat the read-only line the
  // card already states (#29 P2-D). Switching the failing session to 只读 is the
  // user route the capture follows.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(task("release", "failed"), { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.getByTestId("task-composer-input").fill("修复构建并重试");
  await page.getByTestId("composer-send").click();
  await page.getByTestId("execution-action-retry").first().waitFor({ timeout: 20000 });
  await page.getByTestId("composer-permission").click();
  await page.getByTestId("permission-read").click();
  await page.waitForTimeout(400);
  report.states["card-failed-readonly"] = {
    ...(await measureComposer(page)),
    floor: CARD_FLOOR.default,
    note: "只读 + 记录：卡片说明行承担规则，输入框不再重复",
    cardHintVisible: await page.getByTestId("execution-readonly-hint").isVisible(),
    composerHintVisible: await page.getByTestId("composer-readonly-hint").count(),
  };
  await page.screenshot({ path: `${OUT}/renderer/1440-card-failed-readonly.png` });
  await page.close();
}

await browser.close();

/**
 * The slice's geometry claims as assertions, so re-running this file is a real
 * check rather than a capture: the composer keeps one height across every tier,
 * never exceeds the prototype's box (and never the 65% ceiling), the box's
 * button row stays a single line, the message area keeps the [UI 对齐 03] (#27)
 * 400px floor without an execution card and the [UI 对齐 05] (#29) tiered floors
 * with one, and the read-only / warning / paste states behave as specified.
 */
function assertGeometry(measured) {
  const violations = [];
  const heights = Object.values(measured.tiers).map((tier) => tier.composerH);
  const spread = Math.max(...heights) - Math.min(...heights);
  const prototypeHeights = Object.values(measured.prototype).map((tier) => tier.composerH);

  for (const [name, tier] of Object.entries(measured.tiers)) {
    const reference = measured.prototype[name];
    if (!tier.composerH || !tier.formH) violations.push(`${name}: the composer is missing from the page`);
    if (tier.rowWrapped) violations.push(`${name}: the composer's button row wrapped (${tier.rowH}px)`);
    if (tier.attachOk !== true) violations.push(`${name}: the attachment entry is ${tier.attach?.w}x${tier.attach?.h}, not ${ATTACH_WIDTH}x${ATTACH_HEIGHT}`);
    if (tier.textareaMinOk !== true) violations.push(`${name}: the textarea is ${tier.textareaH}px, below the prototype's ${TEXTAREA_MIN_H}px minimum`);
    if (tier.noHorizontalOverflow !== true) violations.push(`${name}: the page overflows horizontally`);
    if (tier.composerH > (reference?.composerH ?? Infinity)) {
      violations.push(`${name}: composer ${tier.composerH}px is taller than prototype A's ${reference?.composerH}px`);
    }
    if (tier.composerH > tier.workspaceH * COMPOSER_MAX_SHARE) {
      violations.push(`${name}: composer ${tier.composerH}px exceeds the prototype's ${COMPOSER_MAX_SHARE * 100}% ceiling`);
    }
  }
  if (spread > 2) violations.push(`the composer height moves ${spread}px across tiers (${heights.join("/")})`);
  // Prototype `.composer-wrap{padding:9px 20px 15px}` and `.composer{box-shadow:0 3px
  // 10px #242b3b05}`: the box inset and its shadow are measured, not assumed.
  const reference = measured.prototype["1440x900"] ?? {};
  const inset = reference.inset;
  if (!inset || inset.left === 0) violations.push("prototype A: the reference inset is missing (0px would make this assertion vacuous)");
  if (!(reference.shadow ?? "").includes("3px 10px")) violations.push(`prototype A: unexpected box shadow ${reference.shadow}`);
  if (!(reference.metaGap >= 1)) violations.push(`prototype A: unexpected meta gap ${reference.metaGap}`);
  for (const [name, tier] of Object.entries(measured.tiers)) {
    if (inset && (Math.abs((tier.insetLeft ?? -1) - inset.left) > 2 || Math.abs((tier.insetRight ?? -1) - inset.right) > 2)) {
      violations.push(`${name}: the box is inset ${tier.insetLeft}/${tier.insetRight}px, prototype A uses ${inset.left}/${inset.right}px`);
    }
    // Tailwind keeps its ring/shadow layers next to the utility, so the check is
    // that the prototype's own layer is present rather than string equality.
    if (!(tier.formShadow ?? "").includes(reference.shadow)) {
      violations.push(`${name}: box shadow ${tier.formShadow}, prototype A uses ${reference.shadow}`);
    }
    if ((tier.metaGap ?? 99) > reference.metaGap + 2) {
      violations.push(`${name}: the meta row sits ${tier.metaGap}px under the box, prototype A uses ${reference.metaGap}px`);
    }
  }
  for (const name of ["1440x900", "1024x800", "720x760"]) {
    if (!heights.includes(measured.tiers[name]?.composerH)) violations.push(`${name}: missing from the tier sweep`);
  }
  // The prototype keeps one box height at every tier; ours must not answer with
  // a tier-specific padding rewrite.
  if (new Set(prototypeHeights).size !== 1) violations.push(`prototype A's own composer height is not constant (${prototypeHeights.join("/")})`);
  const paddings = new Set(Object.values(measured.prototype).map((tier) => tier.padding));
  if (paddings.size !== 1) violations.push(`prototype A's composer padding differs per tier (${[...paddings].join(" | ")})`);

  const cardFree = measured.states.cardFree;
  if (cardFree.messagesH < MESSAGES_FLOOR_NO_CARD) {
    violations.push(`card-free state: message area ${cardFree.messagesH}px < the ${MESSAGES_FLOOR_NO_CARD}px floor from [UI 对齐 03] (#27)`);
  }
  if (cardFree.cardPresent) violations.push("card-free state: an execution card is still on screen");
  // The card floors were ruled for the 1440×900 column ([UI 对齐 05] (#29)); the
  // narrower tiers sit in an 800px-tall viewport and are recorded, not floored.
  for (const [name, tier] of Object.entries(measured.tiers)) {
    if (!tier.cardPresent || name !== "1440x900") continue;
    const floor = CARD_FLOOR.default;
    if (tier.messagesH < floor) violations.push(`${name}: message area ${tier.messagesH}px < the ${floor}px floor with an execution card`);
  }

  // [UI 对齐 06] #30 review P1-1: the composer markup changed the column the
  // [UI 对齐 05] (#29) floors were ruled for, so every card state measured here is
  // held to its own floor.
  for (const [name, state] of Object.entries(measured.states)) {
    if (!name.startsWith("card-")) continue;
    if (state.messagesH < state.floor) violations.push(`${name}: message area ${state.messagesH}px < the ${state.floor}px floor with an execution card`);
    if (state.cardH > CARD_GUARDRAIL) violations.push(`${name}: card ${state.cardH}px > the ${CARD_GUARDRAIL}px guardrail`);
  }
  const failedReadonly = measured.states["card-failed-readonly"];
  if (failedReadonly.cardHintVisible !== true) violations.push("read-only + record: the card's visible rule is missing");
  if (failedReadonly.composerHintVisible !== 0) {
    violations.push("read-only + record: the composer repeats the read-only rule the card already states");
  }

  const readOnly = measured.states.readOnly;
  if (!readOnly.textareaDisabled || !readOnly.attachDisabled || !readOnly.fileInputDisabled || !readOnly.sendDisabled) {
    violations.push("read-only state: an entry stayed enabled");
  }
  if (!readOnly.hintVisible || !readOnly.hint?.includes("只读会话")) violations.push("read-only state: the visible reason is missing");

  const paste = measured.states.paste;
  if (paste.defaultPrevented !== true) violations.push("paste: an image paste was not intercepted");
  if (!/^粘贴图片-\w+\.(png|jpe?g|webp|gif)$/.test(paste.attachmentLabels[0] ?? "")) {
    violations.push(`paste: unexpected attachment label ${paste.attachmentLabels[0] ?? "(none)"}`);
  }
  if (!(paste.attachmentDetail ?? "").includes("仅本页保留")) violations.push("paste: the attachment lost its source line");
  if (paste.draftText !== "看这张截图") violations.push(`paste: the clipboard text is not in the draft (${paste.draftText})`);
  if (paste.toast === null) violations.push("paste: no confirmation toast");

  const lightbox = measured.states.pasteLightbox;
  if (lightbox.dialogRole !== true) violations.push("attachment lightbox: the preview is not inside a dialog");
  if (lightbox.imagePresent !== true) violations.push("attachment lightbox: the image is not shown");
  if (!(lightbox.detail ?? "").includes("仅本页保留")) violations.push("attachment lightbox: the source line is missing");

  const warning = measured.states.unsupportedImage;
  if (warning.warningRole !== "status") violations.push("unsupported image: the warning is not a status line");
  if (warning.inlineModelEntry < 1) violations.push("unsupported image: the inline model entry is missing");
  if (warning.sendDisabled !== true) violations.push("unsupported image: the send button is not disabled");
  if (warning.attachmentsKept < 1) violations.push("unsupported image: the attachment was dropped instead of kept");

  const heavy = measured.states.heavyAttachments;
  const heavyPrototype = measured.states.heavyAttachmentsPrototype;
  for (const [name, state] of Object.entries(measured.states)) {
    if (state.strip && state.stripCapped === false) violations.push(`${name}: the attachment strip grew past ${STRIP_MAX_H}px without scrolling`);
  }
  if (heavy.composerH > heavyPrototype.composerH) {
    violations.push(`12 attachments: composer ${heavy.composerH}px is taller than prototype A's ${heavyPrototype.composerH}px`);
  }
  if (heavy.messagesH < heavyPrototype.messagesH) {
    violations.push(`12 attachments: message area ${heavy.messagesH}px is smaller than prototype A's ${heavyPrototype.messagesH}px`);
  }
  if (heavy.composerH > heavy.workspaceH * COMPOSER_MAX_SHARE) {
    violations.push(`12 attachments: composer ${heavy.composerH}px exceeds the ${COMPOSER_MAX_SHARE * 100}% ceiling`);
  }

  if (violations.length > 0) throw new Error(`geometry assertions failed:\n- ${violations.join("\n- ")}`);
  return (
    Object.keys(measured.tiers).length +
    Object.keys(measured.prototype).length +
    Object.keys(measured.states).length +
    2
  );
}

report.assertions = { checked: assertGeometry(report), violations: 0 };
await writeFile(`${OUT}/composer.json`, `${JSON.stringify(report, null, 2)}\n`);

console.log("--- composer height per tier (renderer vs prototype) ---");
for (const [name, tier] of Object.entries(report.tiers)) {
  console.log(
    `${name}: renderer=${tier.composerH} prototype=${report.prototype[name].composerH} textarea=${tier.textareaH} attach=${tier.attach?.w}x${tier.attach?.h} row=${tier.rowH} wrapped=${tier.rowWrapped} meta=${tier.metaH} messages=${tier.messagesH}`,
  );
}
console.log("--- states ---");
console.log(`card-free: messages=${report.states.cardFree.messagesH} composer=${report.states.cardFree.composerH}`);
console.log(`read-only: hint=${report.states.readOnly.hintVisible} attachDisabled=${report.states.readOnly.attachDisabled}`);
console.log(`paste: ${report.states.paste.attachmentLabels.join(",")} toast=${report.states.paste.toast}`);
console.log(`attachment lightbox: image=${report.states.pasteLightbox.imagePresent} detail=${report.states.pasteLightbox.detail}`);
console.log(`unsupported image: sendDisabled=${report.states.unsupportedImage.sendDisabled} kept=${report.states.unsupportedImage.attachmentsKept}`);
console.log(
  `12 attachments: renderer=${report.states.heavyAttachments.composerH}/messages ${report.states.heavyAttachments.messagesH} prototype=${report.states.heavyAttachmentsPrototype.composerH}/messages ${report.states.heavyAttachmentsPrototype.messagesH}`,
);
console.log("--- execution-card states ([UI 对齐 05] #29 floors) ---");
for (const [name, state] of Object.entries(report.states)) {
  if (name.startsWith("card-")) console.log(`${name}: messages=${state.messagesH} composer=${state.composerH} card=${state.cardH} floor=${state.floor}`);
}
console.log(`geometry assertions: ok (${report.assertions.checked} measured states)`);
