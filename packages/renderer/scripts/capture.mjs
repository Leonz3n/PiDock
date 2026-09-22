import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { CHROME, EVIDENCE_DIR, PROTOTYPE_BASE, RENDERER_BASE, VIEWPORT } from "./evidence.mjs";

const rendererPages = [
  { name: "attention", path: "/attention" },
  { name: "project", path: "/projects/atlas" },
  { name: "task-main", path: "/projects/atlas/tasks/release?session=main" },
  { name: "task-deploy", path: "/projects/atlas/tasks/release?session=deploy" },
  { name: "task-failed", path: "/projects/atlas/tasks/release?session=failed" },
  { name: "task-directory", path: "/projects/atlas/tasks/design-docs?session=main" },
  // Mixed Git + ordinary-directory task with the files panel open, so the
  // directory badge/entry and the directory root chooser are captured.
  { name: "task-mixed", path: "/projects/atlas/tasks/release?session=main", click: 'button:text-is("文件")' },
  // Newly restored runtime panels and dialogs (round 5).
  { name: "task-logs", path: "/projects/atlas/tasks/release?session=main", click: 'button:text-is("日志")' },
  {
    name: "task-subagent",
    path: "/projects/atlas/tasks/release?session=main",
    click: ['button[aria-label^="查看 Subagent"]'],
  },
  {
    name: "task-permission",
    path: "/projects/atlas/tasks/release?session=main",
    click: ['button[aria-label^="选择权限"]'],
  },
  {
    name: "task-model",
    path: "/projects/atlas/tasks/release?session=main",
    click: ['button[aria-label^="选择模型"]'],
  },
  {
    name: "task-thinking",
    path: "/projects/atlas/tasks/release?session=main",
    // Only models declaring reasoning levels show the picker (prototype's
    // `thinkingControl()`), so switch to the local reasoning model first.
    click: [
      'button[aria-label^="选择模型"]',
      'button[aria-label="模型 本地 Qwen"]',
      'button[aria-label="选择推理档位"]',
    ],
  },
  {
    name: "task-context",
    path: "/projects/atlas/tasks/release?session=main",
    click: ['button[aria-label="查看上下文占用"]'],
  },
  {
    name: "new-task-scheduled",
    path: "/schedules",
    click: ['button:text-is("新建定时任务")', 'input[aria-label="定时任务"]'],
  },
  {
    name: "project-management",
    path: "/projects/atlas",
    click: ['button:text-is("项目管理")'],
  },
  {
    name: "project-edit",
    path: "/projects/atlas",
    click: ['button:text-is("编辑项目")'],
  },
  {
    name: "environment-management",
    path: "/projects/atlas",
    click: ['button:text-is("管理环境")'],
  },
  {
    name: "provider-edit",
    path: "/providers",
    click: ['button:text-is("编辑")'],
  },
  {
    name: "capability-detail",
    path: "/capabilities",
    click: ['button:text-is("详情")'],
  },
  {
    name: "capability-add",
    path: "/capabilities",
    click: ['button:text-is("添加技能来源")'],
  },
  {
    name: "schedule-edit",
    path: "/schedules",
    click: ['button:text-is("编辑")'],
  },
  {
    name: "delivery",
    path: "/projects/atlas/tasks/release?session=main",
    click: ['button:text-is("审阅与交付")'],
  },
  {
    name: "composer-candidates",
    path: "/projects/atlas/tasks/release?session=main",
    fill: [['[aria-label="消息输入"]', "/"]],
  },
  {
    name: "remote-preview",
    path: "/remote",
    click: ['button:text-is("手机视图")'],
  },
  {
    name: "repo-binding",
    path: "/settings",
    click: ['button:text-is("编辑绑定")'],
  },
  { name: "env", path: "/env" },
  { name: "providers", path: "/providers" },
  { name: "usage", path: "/usage" },
  { name: "schedules", path: "/schedules" },
  { name: "capabilities", path: "/capabilities" },
  { name: "remote", path: "/remote" },
  { name: "archive", path: "/archive" },
  { name: "settings", path: "/settings" },
];

const prototypePages = [
  { name: "project" },
  { name: "task-main", click: '[data-action="task:0"]' },
  { name: "env", click: 'button[data-action="view:env"]' },
  { name: "providers", click: 'button[data-action="view:providers"]' },
  { name: "usage", click: 'button[data-action="view:usage"]' },
  { name: "schedules", click: 'button[data-action="view:schedules"]' },
  { name: "capabilities", click: 'button[data-action="view:capabilities"]' },
  { name: "remote", click: 'button[data-action="view:remote"]' },
  { name: "archive", click: 'button[data-action="view:archive"]' },
];

/**
 * One capture routine for both route-driven renderer pages and click-driven
 * prototype pages. Page errors and console errors are collected per page and
 * returned so the caller can persist them next to the screenshots; the claim
 * "the pages rendered without errors" is only checkable if the errors are kept.
 *
 * Errors record the *intended* target (the route or the prototype URL) rather
 * than `page.url()`: at error time the browser may still be on the previous
 * page, which made the record point at the wrong route.
 */
async function captureScreens(browser, { base, dir, pages }) {
  const target = `${EVIDENCE_DIR}${dir}/`;
  await mkdir(target, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  let intendedTarget = base;
  page.on("pageerror", (error) => errors.push({ page: intendedTarget, kind: "pageerror", message: String(error) }));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ page: intendedTarget, kind: "console", message: message.text() });
  });
  await page.goto(base, { waitUntil: "networkidle" });
  for (const { name, path, click, fill } of pages) {
    intendedTarget = path ? `${base}${path}` : base;
    if (path) await page.goto(intendedTarget, { waitUntil: "networkidle" });
    if (fill) {
      for (const [selector, value] of fill) {
        await page.fill(selector, value);
        await page.waitForTimeout(180);
      }
    }
    if (click) {
      // A single selector or an ordered click sequence (dialogs need the opener
      // first). The sequence is recorded so a screenshot is reproducible.
      const steps = Array.isArray(click) ? click : [click];
      for (const selector of steps) {
        await page.click(selector);
        await page.waitForTimeout(180);
      }
    }
    await page.screenshot({ path: `${target}${name}.png` });
    console.log(`${dir}/${name}.png`);
  }
  await context.close();
  return errors;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const rendererErrors = await captureScreens(browser, { base: RENDERER_BASE, dir: "renderer", pages: rendererPages });
  const prototypeErrors = await captureScreens(browser, { base: PROTOTYPE_BASE, dir: "prototype", pages: prototypePages });
  const report = {
    rendererErrors,
    prototypeErrors,
    // The prototype is read-only reference material, so its errors are
    // announced rather than failed; a renderer error still exits non-zero.
    prototypeErrorsAnnounced: prototypeErrors.length > 0,
  };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(`${EVIDENCE_DIR}capture-errors.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${EVIDENCE_DIR}capture-errors.json`);
  if (prototypeErrors.length > 0) {
    console.warn(
      `prototype reported ${prototypeErrors.length} error(s) (prototypes/ is read-only, not fixed here): ${prototypeErrors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  if (rendererErrors.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
