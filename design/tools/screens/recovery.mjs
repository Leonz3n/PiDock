import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill,
  appFrame, sidebar, topbar,
} from "../lib.mjs";

function sourceState(x, y, w, o) {
  const out = [];
  out.push(line(x, y + 62.5, x + w, y + 62.5));
  if (o.ok) {
    out.push(circle(x + 12, y + 18, 9, { fill: C.settledSoft }));
    out.push(icon("check", x + 6, y + 12, { size: 12, color: C.settled, sw: 2.2 }));
  } else {
    out.push(circle(x + 12, y + 18, 9, { fill: C.dangerSoft }));
    out.push(icon("alert", x + 6, y + 12, { size: 12, color: C.danger, sw: 2 }));
  }
  out.push(text(x + 32, y + 16, o.name, { size: 12.5, weight: 500, family: F.mono }));
  out.push(text(x + 32, y + 34, o.meta, { size: 10.5, fill: C.muted }));
  out.push(text(x + 32, y + 51, o.detail, { size: 10.5, fill: o.ok ? C.ink2 : C.danger, family: o.mono ? F.mono : F.sans }));
  if (o.action) {
    out.push(rect(x + w - 78, y + 20, 62, 26, { fill: o.ok ? C.surface : C.primary, stroke: o.ok ? C.line : "none", rx: 6 }));
    out.push(tmid(x + w - 68, y + 20, 26, 10.5, o.action, { fill: o.ok ? C.ink2 : C.white, weight: 500 }));
  }
  return out.join("");
}

export function recovery() {
  const out = [];
  out.push(sidebar("task", { projectSelected: true, taskSelected: true }));
  out.push(topbar("Atlas 结算系统", {
    breadcrumbTail: "准备工作副本",
    secondary: "任务详情",
  }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  out.push(text(x, 86, "任务", { size: 10.5, weight: 600, fill: C.muted, spacing: 1.2 }));
  out.push(text(x, 120, "准备工作副本时中断", { size: 24, weight: 600, spacing: -0.3 }));
  out.push(text(x, 146, "1102-atlas · 2 个来源已准备，1 个失败 · 上次尝试 10:26", { size: 11.5, fill: C.muted, family: F.mono }));
  out.push(line(x, 168.5, right, 168.5));

  // Main recovery panel
  const pw = 760;
  const py = 192;
  const ph = 548;
  out.push(rect(x, py, pw, ph, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(rect(x, py + 1, 3, ph - 2, { fill: C.danger, rx: 1.5 }));

  out.push(circle(x + 34, py + 40, 11, { fill: C.dangerSoft }));
  out.push(icon("alert", x + 27, py + 33, { size: 14, color: C.danger, sw: 2 }));
  out.push(text(x + 56, py + 38, "worktree 准备未完成", { size: 18, weight: 600 }));
  out.push(text(x + 56, py + 57, "已准备的资源会保留；失败的来源可以单独重试，不会自动回退或静默替换。", { size: 11, fill: C.muted }));

  out.push(text(x + 24, py + 98, "来源状态", { size: 11, weight: 600, fill: C.ink2 }));
  const sy = py + 112;
  out.push(sourceState(x + 24, sy, pw - 48, {
    ok: true, name: "atlas-api", meta: "独立 worktree · feat/settlement-paging",
    detail: "~/PiDock/atlas/1102-atlas-api · 9f3c21a", action: "查看目录",
  }));
  out.push(sourceState(x + 24, sy + 64, pw - 48, {
    ok: false, name: "atlas-web", meta: "独立 worktree · 需要 release/v2",
    detail: "获取失败：远程分支 release/v2 不存在（refspec 未匹配）", action: "重试",
  }));
  out.push(sourceState(x + 24, sy + 128, pw - 48, {
    ok: true, name: "design-tokens", meta: "共享目录 · 不创建副本",
    detail: "~/work/design-tokens · 链接已建立", action: "查看目录", mono: true,
  }));

  // Preserved note
  out.push(rect(x + 24, py + 330, pw - 48, 66, { fill: C.sunken, rx: 8 }));
  out.push(icon("archive", x + 40, py + 348, { size: 15, color: C.ink2 }));
  out.push(text(x + 64, py + 350, "已准备的副本和你的修改都已保留", { size: 11.5, weight: 500 }));
  out.push(text(x + 64, py + 368, "重试只处理失败来源，不重新创建已成功的 worktree；放弃时需要明确选择范围。", { size: 10.5, fill: C.muted }));
  out.push(text(x + 64, py + 384, "来源目录和已有未提交代码不会被修改。", { size: 10.5, fill: C.muted }));

  // Actions
  out.push(text(x + 24, py + 436, "下一步", { size: 11, weight: 600, fill: C.ink2 }));
  out.push(rect(x + 24, py + 448, 112, 34, { fill: C.primary, rx: 7 }));
  out.push(tmid(x + 36, py + 448, 34, 11.5, "重试失败项", { fill: C.white, weight: 500 }));
  out.push(rect(x + 148, py + 448, 128, 34, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(x + 160, py + 448, 34, 11.5, "仅查看任务详情", { fill: C.ink2 }));
  out.push(rect(x + 288, py + 448, 116, 34, { fill: "none", rx: 7 }));
  out.push(tmid(x + 300, py + 448, 34, 11.5, "放弃未完成来源", { fill: C.danger }));
  out.push(text(x + 24, py + 508, "失败信息只描述本次获取；网络失败不等于分支不存在。", { size: 10.5, fill: C.muted }));
  out.push(text(x + 24, py + 526, "复制错误信息", { size: 10.5, fill: C.primary }));

  // Right facts rail
  const rx = x + pw + 24;
  const rw = right - rx;
  out.push(rect(rx, py, rw, 290, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(text(rx + 20, py + 30, "任务事实", { size: 12.5, weight: 600 }));
  const facts = [
    ["任务 ID", "1102-atlas"],
    ["任务根", "~/PiDock/atlas"],
    ["创建", "今天 10:18"],
    ["上次尝试", "今天 10:26"],
    ["状态", "准备未完成"],
  ];
  facts.forEach(([k, v], i) => {
    const fy = py + 54 + i * 42;
    out.push(text(rx + 20, fy, k, { size: 10.5, fill: C.muted }));
    out.push(text(rx + 20, fy + 17, v, { size: 11.5, fill: i === 4 ? C.danger : C.ink2, family: F.mono }));
    if (i < 4) out.push(line(rx + 20, fy + 28, rx + rw - 20, fy + 28));
  });

  out.push(rect(rx, py + 310, rw, 238, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(text(rx + 20, py + 340, "恢复规则", { size: 12.5, weight: 600 }));
  const rules = [
    ["不覆盖来源目录", "已有工作目录和未提交代码保持原样。"],
    ["不自动重试", "获取失败后保留表单，由你触发重试。"],
    ["不认领未知目录", "路径身份不符时报告修复需求。"],
  ];
  rules.forEach(([t, d], i) => {
    const ry = py + 362 + i * 58;
    out.push(circle(rx + 24, ry + 5, 3, { fill: C.settled }));
    out.push(text(rx + 36, ry + 9, t, { size: 11, weight: 500 }));
    out.push(text(rx + 36, ry + 27, d, { size: 10.5, fill: C.muted }));
  });

  out.push(text(x, 790, "任务不会因为准备失败而消失；重开应用后会回到这里。", { size: 10.5, fill: C.muted }));

  return appFrame(out.join(""));
}
