import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill,
  appFrame, sidebar, topbar, sectionTitle,
} from "../lib.mjs";

function sourceTile(x, y, w, o) {
  const out = [];
  out.push(rect(x, y, w, 104, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(rect(x + 16, y + 16, 30, 30, { fill: o.kind === "git" ? C.primarySoft : C.sunken, rx: 7 }));
  out.push(icon(o.kind === "git" ? "branch" : "folder", x + 24, y + 24, { size: 15, color: o.kind === "git" ? C.primary : C.ink2 }));
  out.push(text(x + 56, y + 29, o.name, { size: 13, weight: 600 }));
  out.push(text(x + 56, y + 46, o.meta, { size: 10.5, fill: C.muted }));
  out.push(text(x + 16, y + 76, o.path, { size: 10.5, fill: C.muted, family: F.mono }));
  if (o.badge) out.push(pill(x + w - 16, y + 68, o.badge, o.kind === "git" ? "settled" : "outline", { size: 10, h: 20, align: "right" }).svg);
  return out.join("");
}

export function project() {
  const out = [];
  out.push(sidebar("projects", { projectSelected: true, taskSelected: false, listTitle: "项目任务" }));
  out.push(topbar("项目", { breadcrumbTail: "Atlas 结算系统", primary: "新建任务" }));

  const x = SIDEBAR + 32;
  const right = W - 32;
  const w = right - x;

  out.push(text(x, 116, "Atlas 结算系统", { size: 30, weight: 600, spacing: -0.5 }));
  out.push(text(x, 142, "4 个来源 · 6 个任务 · 2 个定时任务 · 最近活动 2 分钟前", { size: 12, fill: C.muted }));
  out.push(rect(right - 116, 100, 84, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(right - 104, 100, 32, 12, "编辑项目", { fill: C.ink2 }));
  out.push(icon("dots", right - 18, 106, { size: 18, color: C.muted }));

  // Sources
  out.push(sectionTitle(x, 190, "来源", { size: 13, action: "管理来源", width: w }));
  const gap = 16;
  const tw = (w - gap * 2) / 3;
  out.push(sourceTile(x, 206, tw, {
    kind: "git", name: "atlas-api", meta: "Git · origin/main · 9f3c21a",
    path: "~/work/atlas-api", badge: "支持 worktree",
  }));
  out.push(sourceTile(x + tw + gap, 206, tw, {
    kind: "git", name: "atlas-web", meta: "Git · origin/develop · 41c8e07",
    path: "~/work/atlas-web", badge: "支持 worktree",
  }));
  out.push(sourceTile(x + (tw + gap) * 2, 206, tw, {
    kind: "dir", name: "design-tokens", meta: "普通目录 · 共享原文件",
    path: "~/work/design-tokens", badge: "共享目录",
  }));

  // Tabs
  const tabY = 338;
  out.push(line(x, tabY, right, tabY, { stroke: C.line }));
  const tabs = [["任务", "3", true], ["已归档", "2", false], ["定时任务", "2", false], ["设置", "", false]];
  let tx = x;
  tabs.forEach(([label, count, active]) => {
    const tw2 = 34 + label.length * 14 + (count ? 18 : 0);
    if (active) {
      out.push(text(tx, tabY + 25, label, { size: 13, weight: 600 }));
      out.push(rect(tx, tabY + 37, tw2, 2, { fill: C.primary }));
      if (count) out.push(tmid(tx + 30, tabY + 10, 16, 10, count, { fill: C.primary }));
    } else {
      out.push(text(tx, tabY + 25, label, { size: 13, fill: C.ink2 }));
      if (count) out.push(tmid(tx + 30, tabY + 10, 16, 10, count, { fill: C.muted }));
    }
    tx += tw2 + 30;
  });
  out.push(line(x, tabY + 38.5, right, tabY + 38.5, { stroke: C.line }));

  // Task table
  const hy = 396;
  out.push(rect(x, hy, w, 30, { fill: C.sunken, rx: 5 }));
  [["任务", x + 16], ["来源", x + 430], ["状态", x + 650], ["会话", x + 800], ["最近活动", x + 900]].forEach(([label, cx]) => {
    out.push(text(cx, hy + 20, label, { size: 11, weight: 500, fill: C.muted }));
  });

  const tasks = [
    ["修复结算对账的分页边界", "修复重复游标，补回归测试", "独立 worktree · atlas-api", "执行中", "running", "2 分钟前", "2"],
    ["核对导出接口的错误码", "只读分析，不改代码", "共享目录 · atlas-web", "等待确认", "attention", "18 分钟前", "1"],
    ["生成 v0.2 发布说明", "汇总本周已合并 PR", "独立 worktree · atlas-api", "已完成", "settled", "今天 10:42", "3"],
    ["清理旧迁移脚本", "归档前的最后检查", "共享目录 · design-tokens", "已停止", "outline", "昨天 18:20", "1"],
  ];
  tasks.forEach((t, i) => {
    const ry = hy + 30 + i * 54;
    out.push(line(x, ry + 53.5, right, ry + 53.5));
    out.push(icon("message", x + 16, ry + 18, { size: 15, color: t[4] === "running" ? C.primary : C.muted }));
    out.push(text(x + 42, ry + 21, t[0], { size: 13, weight: 500 }));
    out.push(text(x + 42, ry + 39, t[1], { size: 10.5, fill: C.muted }));
    out.push(text(x + 430, ry + 31, t[2], { size: 10.5, fill: C.ink2, family: F.mono }));
    out.push(pill(x + 650, ry + 16, t[3], t[4], { size: 11, h: 22 }).svg);
    out.push(text(x + 800, ry + 31, `${t[6]} 个`, { size: 11.5, fill: C.ink2 }));
    out.push(text(x + 900, ry + 31, t[5], { size: 11.5, fill: C.muted }));
    out.push(icon("chevronRight", right - 22, ry + 19, { size: 14, color: C.lineStrong }));
  });

  // Schedules
  out.push(sectionTitle(x, 660, "定时任务", { size: 14, action: "查看记录", width: w }));
  out.push(rect(x, 674, w, 150, { fill: C.surface, stroke: C.line, rx: 9 }));
  const schedules = [
    ["每周仓库改动摘要", "每周日 18:00 · Asia/Shanghai", "下次 11月8日 18:00", "已启用", "settled"],
    ["每日风险巡检", "周一至周五 17:00 · Asia/Shanghai", "下次 明天 17:00", "已启用", "settled"],
  ];
  schedules.forEach(([name, rule, next, state, kind], i) => {
    const ry = 690 + i * 64;
    out.push(circle(x + 24, ry + 16, 4, { fill: C.primary }));
    out.push(text(x + 40, ry + 20, name, { size: 13, weight: 500 }));
    out.push(text(x + 40, ry + 40, rule, { size: 10.5, fill: C.muted, family: F.mono }));
    out.push(text(x + 520, ry + 20, next, { size: 11.5, fill: C.ink2 }));
    out.push(pill(x + w - 20, ry + 8, state, kind, { size: 10.5, h: 20, align: "right" }).svg);
    if (i === 0) out.push(line(x, ry + 56, right, ry + 56));
  });
  out.push(text(x + w - 20, 806, "上次执行 11月1日 18:00 · 已完成", { size: 10.5, fill: C.muted, anchor: "end" }));

  return appFrame(out.join(""));
}
