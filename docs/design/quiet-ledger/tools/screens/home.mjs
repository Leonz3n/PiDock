import {
  C, F, W, H, SIDEBAR, TOPBAR,
  text, tmid, rect, line, circle, icon, pill, chip,
  appFrame, sidebar, topbar, sectionTitle,
} from "../lib.mjs";

export function home() {
  const out = [];
  out.push(sidebar("home", { projectSelected: false, taskSelected: false, listTitle: "最近任务" }));
  out.push(topbar("工作台", { primary: "新建任务", meta: "2026年11月2日 周一" }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  // Page heading
  out.push(text(x, 124, "工作台", { size: 30, weight: 600, spacing: -0.6 }));
  out.push(text(x, 150, "3 个任务正在运行，1 个会话等待你确认。", { size: 13, fill: C.muted }));

  // Attention strip
  const ay = 174;
  out.push(rect(x, ay, right - x, 54, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(rect(x, ay + 8, 3, 38, { fill: C.attention, rx: 1.5 }));
  out.push(circle(x + 24, ay + 27, 4, { fill: C.attention }));
  out.push(text(x + 40, ay + 24, "1 个会话等待你确认", { size: 13.5, weight: 600 }));
  out.push(text(x + 40, ay + 42, "升级 Provider 配置 · 即将运行 pnpm install，目标 ~/work/infra", { size: 12, fill: C.muted }));
  out.push(rect(right - 96, ay + 13, 72, 28, { fill: C.primary, rx: 7 }));
  out.push(tmid(right - 84, ay + 13, 28, 12, "去处理", { fill: C.white, weight: 500 }));

  // Active tasks
  const ty = 264;
  out.push(sectionTitle(x, ty, "进行中的任务", { action: "查看全部", width: right - x }));
  out.push(text(x, ty + 20, "按最近活动排序", { size: 11.5, fill: C.muted }));

  const hy = ty + 36;
  out.push(rect(x, hy, right - x, 30, { fill: C.sunken, rx: 5 }));
  const cols = [
    [x + 16, "任务"],
    [x + 464, "项目"],
    [x + 644, "状态"],
    [x + 794, "最近活动"],
  ];
  cols.forEach(([cx, label]) => out.push(text(cx, hy + 20, label, { size: 11, weight: 500, fill: C.muted })));

  const tasks = [
    {
      title: "修复结算对账的分页边界",
      project: "Atlas 结算系统",
      meta: "独立 worktree · feat/settlement-paging · 9f3c21a",
      state: "执行中",
      kind: "running",
      time: "2 分钟前",
    },
    {
      title: "升级 Provider 配置",
      project: "基础设施",
      meta: "共享目录 · ~/work/infra",
      state: "等待确认",
      kind: "attention",
      time: "6 分钟前",
    },
    {
      title: "生成 v0.2 发布说明",
      project: "Atlas 结算系统",
      meta: "独立 worktree · release-notes",
      state: "已完成",
      kind: "settled",
      time: "今天 10:42",
    },
    {
      title: "归档旧迁移脚本",
      project: "个人脚本",
      meta: "共享目录 · ~/scripts",
      state: "已停止",
      kind: "outline",
      time: "昨天 18:20",
    },
  ];

  tasks.forEach((t, i) => {
    const ry = hy + 30 + i * 52;
    if (i % 2 === 1) out.push(rect(x, ry, right - x, 52, { fill: C.surface, opacity: 0.6 }));
    out.push(line(x, ry + 52 - 0.5, right, ry + 52 - 0.5));
    out.push(icon(i === 0 ? "message" : i === 3 ? "archive" : "branch", x + 16, ry + 18, { size: 15, color: i === 0 ? C.primary : C.muted }));
    out.push(text(x + 42, ry + 21, t.title, { size: 13.5, weight: 500 }));
    out.push(text(x + 42, ry + 39, t.meta, { size: 10.5, fill: C.muted, family: F.mono }));
    out.push(text(x + 464, ry + 31, t.project, { size: 12.5, fill: C.ink2 }));
    out.push(pill(x + 644, ry + 14, t.state, t.kind, { size: 11, h: 22 }).svg);
    out.push(text(x + 794, ry + 31, t.time, { size: 12, fill: C.muted }));
    out.push(icon("chevronRight", right - 24, ry + 18, { size: 14, color: C.lineStrong }));
  });

  // Two-column lower area
  const py = 584;
  const leftW = 700;
  out.push(sectionTitle(x, py, "项目", { action: "管理项目", width: leftW }));
  out.push(rect(x, py + 14, leftW, 276, { fill: C.surface, stroke: C.line, rx: 10 }));

  const projects = [
    ["Atlas 结算系统", "4 个来源 · 6 个任务 · 2 个定时任务", "A", C.primarySoft, C.primary],
    ["基础设施", "2 个来源 · 3 个任务 · 1 个定时任务", "基", C.attentionSoft, C.attention],
    ["文档站", "1 个来源 · 2 个任务", "文", C.settledSoft, C.settled],
  ];
  projects.forEach(([name, meta, letter, bg, fg], i) => {
    const ry = py + 14 + 20 + i * 76;
    out.push(rect(x + 20, ry, 34, 34, { fill: bg, rx: 9 }));
    out.push(text(x + 37, ry + 22, letter, { size: 13, weight: 600, fill: fg, anchor: "middle" }));
    out.push(text(x + 68, ry + 15, name, { size: 13.5, weight: 500 }));
    out.push(text(x + 68, ry + 33, meta, { size: 11.5, fill: C.muted }));
    if (i < 2) out.push(line(x + 20, ry + 52, x + leftW - 20, ry + 52));
    out.push(icon("chevronRight", x + leftW - 32, ry + 10, { size: 14, color: C.lineStrong }));
  });

  // Schedule panel
  const rx = x + leftW + 24;
  const rw = right - rx;
  out.push(sectionTitle(rx, py, "今天的定时任务", { action: "全部规则", width: rw }));
  out.push(rect(rx, py + 14, rw, 276, { fill: C.surface, stroke: C.line, rx: 10 }));

  const runs = [
    ["每周仓库改动摘要", "Atlas 结算系统", "18:00", "等待触发"],
    ["风险巡检", "基础设施", "17:00", "执行中"],
    ["站会主题准备", "Atlas 结算系统", "09:15", "已完成"],
  ];
  runs.forEach(([name, project, time, state], i) => {
    const ry = py + 30 + i * 78;
    out.push(text(rx + 20, ry + 16, name, { size: 13, weight: 500 }));
    out.push(text(rx + 20, ry + 34, project, { size: 11.5, fill: C.muted }));
    out.push(text(rx + 20, ry + 54, time, { size: 12, fill: C.ink2, family: F.mono }));
    const kind = state === "执行中" ? "running" : state === "已完成" ? "settled" : "outline";
    out.push(pill(rx + rw - 20, ry + 6, state, kind, { size: 10.5, h: 20, align: "right" }).svg);
    if (i < 2) out.push(line(rx + 20, ry + 64, rx + rw - 20, ry + 64));
  });

  // Footer hint
  out.push(text(x, 884, "所有数据来自本机 Host；关闭窗口后任务继续运行，退出应用会先停止 Agent。", { size: 11, fill: C.muted }));

  return appFrame(out.join(""));
}
