import {
  C, F, W, H,
  text, tmid, rect, line, circle, icon, pill,
  appFrame,
} from "../lib.mjs";

function segmented(x, y, labels, selected, w = 156) {
  const out = [];
  out.push(rect(x, y, w * labels.length, 30, { fill: C.sunken, rx: 7 }));
  labels.forEach((label, i) => {
    const sx = x + i * w;
    if (i === selected) out.push(rect(sx, y, w, 30, { fill: C.surface, stroke: C.line, rx: 7 }));
    out.push(tmid(sx, y, 30, 11.5, label, {
      fill: i === selected ? C.ink : C.muted,
      weight: i === selected ? 500 : 400,
      anchor: "middle",
    }));
  });
  return out.join("");
}

function sourceCard(o) {
  const { x, y, w, name, kind, meta, mode, selected, branch, commit, path, badge, warning } = o;
  const out = [];
  out.push(rect(x, y, w, 142, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(rect(x + 20, y + 20, 34, 34, { fill: kind === "git" ? C.primarySoft : C.sunken, rx: 8 }));
  out.push(icon(kind === "git" ? "branch" : "folder", x + 29, y + 29, { size: 16, color: kind === "git" ? C.primary : C.ink2 }));
  out.push(text(x + 66, y + 33, name, { size: 14, weight: 600 }));
  out.push(text(x + 66, y + 51, meta, { size: 11.5, fill: C.muted }));

  if (kind === "git") {
    out.push(segmented(x + w - 340, y + 20, ["独立 worktree", "使用已有目录"], selected ? 0 : 1, 160));
    out.push(text(x + 20, y + 82, "基准分支", { size: 10.5, weight: 500, fill: C.muted }));
    out.push(rect(x + 20, y + 89, 190, 28, { fill: C.surface, stroke: C.line, rx: 6 }));
    out.push(text(x + 32, y + 107, branch, { size: 11.5, fill: C.ink2, family: F.mono }));
    out.push(icon("chevronDown", x + 190, y + 98, { size: 12, color: C.muted }));
    out.push(text(x + 226, y + 82, "本次固定提交", { size: 10.5, weight: 500, fill: C.muted }));
    out.push(rect(x + 226, y + 89, 220, 28, { fill: C.sunken, rx: 6 }));
    out.push(circle(x + 240, y + 103, 3, { fill: C.settled }));
    out.push(text(x + 250, y + 107, commit, { size: 11, fill: C.ink2, family: F.mono }));
    out.push(text(x + w - 20, y + 107, "已获取 · 2 分钟前", { size: 10.5, fill: C.muted, anchor: "end" }));
  }

  out.push(text(x + 20, y + 136, path, { size: 11, fill: C.muted, family: F.mono }));
  const bc = pill(x + w - 20, y + 118, badge, warning ? "attention" : "settled", { size: 10.5, h: 22, align: "right" });
  out.push(bc.svg);
  return out.join("");
}

export function newTask() {
  const out = [];
  out.push(rect(0, 0, W, H, { fill: C.canvas }));

  // Top bar
  out.push(rect(0, 0, W, 56, { fill: C.canvas }));
  out.push(line(0, 55.5, W, 55.5));
  out.push(rect(20, 13, 30, 30, { fill: C.primary, rx: 9 }));
  out.push(text(35, 34, "π", { size: 20, weight: 600, fill: C.white, anchor: "middle" }));
  out.push(text(60, 34, "PiDock", { size: 14, weight: 600 }));
  out.push(text(132, 34, "/ 新建任务", { size: 13, fill: C.ink2 }));
  out.push(text(W - 124, 34, "步骤 2 / 3", { size: 12, fill: C.muted }));
  out.push(icon("close", W - 60, 20, { size: 18, color: C.ink2 }));

  // Step rail
  out.push(rect(0, 56, 256, H - 56, { fill: C.sidebar }));
  out.push(line(255.5, 56, 255.5, H, { stroke: C.line }));
  out.push(text(28, 100, "设置任务", { size: 11, weight: 600, fill: C.muted, spacing: 1.1 }));
  const steps = [
    ["1", "基本信息", "名称、项目、模型", "done"],
    ["2", "选择来源", "仓库与目录", "active"],
    ["3", "确认并创建", "检查路径与基线", "todo"],
  ];
  steps.forEach(([n, title, meta, state], i) => {
    const y = 124 + i * 76;
    if (state === "active") out.push(rect(12, y - 16, 232, 60, { fill: C.surface, stroke: C.line, rx: 8 }));
    out.push(circle(36, y, 11, { fill: state === "todo" ? C.sidebar : state === "active" ? C.primary : C.settledSoft, stroke: state === "todo" ? C.lineStrong : "none" }));
    if (state === "done") out.push(icon("check", 29, y - 7, { size: 14, color: C.settled, sw: 2.2 }));
    else out.push(text(36, y + 4, n, { size: 11, weight: 600, fill: state === "active" ? C.white : C.muted, anchor: "middle" }));
    out.push(text(58, y - 2, title, { size: 13, weight: state === "active" ? 600 : 500, fill: state === "todo" ? C.muted : C.ink }));
    out.push(text(58, y + 16, meta, { size: 10.5, fill: C.muted }));
    if (i < 2) out.push(line(36, y + 18, 36, y + 58, { stroke: C.line }));
  });
  out.push(text(28, H - 40, "你可以稍后追加来源；已有来源不会被静默替换。", { size: 10.5, fill: C.muted }));

  // Content
  const x = 304;
  const w = 1088;
  out.push(text(x, 116, "选择任务来源", { size: 24, weight: 600, spacing: -0.4 }));
  out.push(text(x, 144, "选择这个任务要访问的仓库和目录。每个 Git 仓库可以创建独立 worktree，也可以直接使用已有工作目录。", { size: 12.5, fill: C.muted }));

  out.push(text(x, 190, "代码仓库", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(x + w, 190, "+ 添加仓库", { size: 12, fill: C.primary, anchor: "end" }));

  out.push(sourceCard({
    x, y: 206, w,
    name: "atlas-api",
    kind: "git",
    meta: "Git 仓库 · 默认远程 origin",
    mode: "worktree",
    selected: true,
    branch: "origin/main",
    commit: "9f3c21a",
    path: "~/PiDock/atlas/1102-atlas-api",
    badge: "独立副本",
  }));
  out.push(sourceCard({
    x, y: 360, w,
    name: "atlas-web",
    kind: "git",
    meta: "Git 仓库 · 默认远程 origin",
    mode: "existing",
    selected: false,
    branch: "origin/main",
    commit: "41c8e07",
    path: "~/work/atlas-web",
    badge: "共享原文件 · 修改会影响原目录",
    warning: true,
  }));

  out.push(text(x, 536, "普通目录", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(x + w, 536, "+ 添加目录", { size: 12, fill: C.primary, anchor: "end" }));

  // Directory card
  out.push(rect(x, 552, w, 92, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(rect(x + 20, 572, 34, 34, { fill: C.sunken, rx: 8 }));
  out.push(icon("folder", x + 29, 581, { size: 16, color: C.ink2 }));
  out.push(text(x + 66, 585, "design-tokens", { size: 14, weight: 600 }));
  out.push(text(x + 66, 603, "普通目录 · 不要求 Git", { size: 11.5, fill: C.muted }));
  out.push(text(x + 20, 634, "~/work/design-tokens", { size: 11, fill: C.muted, family: F.mono }));
  out.push(pill(x + w - 20, 606, "共享目录", "settled", { size: 10.5, h: 22, align: "right" }).svg);
  out.push(icon("close", x + w - 40, 574, { size: 14, color: C.muted }));

  // Info callout
  out.push(rect(x, 668, w, 64, { fill: C.primarySoft, rx: 8 }));
  out.push(icon("branch", x + 18, 690, { size: 16, color: C.primary }));
  out.push(text(x + 44, 690, "独立 worktree 从本次成功获取的提交创建", { size: 12.5, weight: 600, fill: C.ink }));
  out.push(text(x + 44, 710, "不会覆盖来源目录或已有未提交代码；如果获取失败，会保留表单并标出具体仓库，不会退回旧基线。", { size: 11.5, fill: C.ink2 }));

  // Footer
  out.push(line(0, 824.5, W, 824.5));
  out.push(text(x, 858, "已选择 3 个来源 · 2 个独立副本 · 1 个共享目录", { size: 11.5, fill: C.muted }));
  out.push(rect(W - 256, 840, 88, 34, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(W - 244, 840, 34, 12, "上一步", { fill: C.ink2 }));
  out.push(rect(W - 156, 840, 124, 34, { fill: C.primary, rx: 7 }));
  out.push(tmid(W - 144, 840, 34, 12, "下一步", { fill: C.white, weight: 500 }));
  out.push(icon("arrowRight", W - 48, 850, { size: 14, color: C.white }));

  return appFrame(out.join(""));
}
