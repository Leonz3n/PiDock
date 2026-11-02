import {
  C, F, W, H, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill, chip,
  appFrame, sidebar, topbar,
} from "../lib.mjs";

export function taskBase() {
  const out = [];
  out.push(sidebar("task", { projectSelected: true, taskSelected: true }));
  out.push(topbar("Atlas 结算系统", {
    breadcrumbTail: "修复结算对账的分页边界",
    secondary: "任务详情",
  }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  // Task header
  out.push(text(x, 86, "任务", { size: 10.5, weight: 600, fill: C.muted, spacing: 1.2 }));
  out.push(text(x, 120, "修复结算对账的分页边界", { size: 24, weight: 600, spacing: -0.3 }));

  // Fact chips
  let cx = x;
  const chips = [
    ["独立 worktree", { fill: C.primarySoft, color: C.primary, mono: false }],
    ["atlas-api", {}],
    ["feat/settlement-paging", {}],
    ["9f3c21a", { fill: C.sunken, color: C.ink2 }],
    ["2 个来源", { fill: C.sunken, color: C.ink2, mono: false }],
  ];
  chips.forEach(([label, opt]) => {
    const c = chip(cx, 134, label, opt);
    out.push(c.svg);
    cx += c.w + 6;
  });
  out.push(text(right - 116, 149, "保存于 2 分钟前", { size: 11, fill: C.muted, anchor: "end" }));

  // Tabs
  out.push(line(SIDEBAR, 184.5, W, 184.5));
  const tabY = 192;
  out.push(rect(x - 4, tabY, 178, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(circle(x + 12, tabY + 16, 3, { fill: C.primary }));
  out.push(text(x + 24, tabY + 20, "排查分页重复", { size: 12.5, weight: 500 }));
  out.push(circle(x + 186, tabY + 16, 3, { fill: C.lineStrong }));
  out.push(icon("message", x + 206, tabY + 8, { size: 14, color: C.muted }));
  out.push(text(x + 228, tabY + 20, "写回归测试", { size: 12.5, fill: C.ink2 }));
  out.push(rect(x + 318, tabY + 4, 24, 24, { fill: "none", stroke: C.line, rx: 6 }));
  out.push(icon("plus", x + 324, tabY + 10, { size: 12, color: C.muted }));
  out.push(text(right, tabY + 20, "全部会话", { size: 12, fill: C.primary, anchor: "end" }));
  out.push(line(SIDEBAR, 228.5, W, 228.5));

  // Run bar
  out.push(rect(SIDEBAR, 229, W - SIDEBAR, 36, { fill: C.sunken }));
  out.push(circle(x + 4, 247, 4, { fill: C.primary }));
  out.push(text(x + 18, 251, "执行中 00:42", { size: 12, weight: 500, fill: C.primary }));
  out.push(text(x + 108, 251, "· 正在读取 src/billing/paging.ts", { size: 12, fill: C.ink2 }));
  out.push(rect(right - 64, 239, 64, 25, { fill: C.surface, stroke: C.line, rx: 6 }));
  out.push(icon("stop", right - 56, 245, { size: 12, color: C.danger, sw: 1.8 }));
  out.push(tmid(right - 40, 239, 25, 11.5, "停止", { fill: C.danger, weight: 500 }));
  out.push(line(SIDEBAR, 265.5, W, 265.5));

  return out.join("");
}

export function taskConversation() {
  const out = [];
  const x = 472;
  const w = 760;

  // Date divider
  out.push(line(x, 288.5, x + 300, 288.5, { stroke: C.line }));
  out.push(text(x + 310, 293, "今天", { size: 10.5, fill: C.muted }));
  out.push(line(x + 344, 288.5, x + w, 288.5, { stroke: C.line }));

  // User message
  out.push(text(x, 314, "你 · 10:21", { size: 11, weight: 500, fill: C.muted }));
  out.push(rect(x, 322, w, 58, { fill: C.sunken, rx: 9 }));
  out.push(text(x + 16, 344, "结算单第二页开始出现重复行。先确认分页游标在边界条件下有没有被重复使用，然后补一个回归测试。", { size: 13.5, fill: C.ink }));
  out.push(text(x + 16, 366, "不要改动导出接口。", { size: 13.5, fill: C.ink }));

  // Agent message
  out.push(rect(x, 404, 2, 22, { fill: C.primary }));
  out.push(text(x + 12, 404, "Pi · 10:22", { size: 11, weight: 500, fill: C.muted }));
  out.push(text(x + 12, 426, "分页游标在", { size: 13.5, fill: C.ink2 }));
  out.push(rect(x + 78, 411, 86, 20, { fill: C.code, rx: 4 }));
  out.push(text(x + 84, 425, "created_at", { size: 11, fill: C.ink2, family: F.mono }));
  out.push(text(x + 170, 426, "相同的一组记录之间复用了旧值。我先读取分页实现和现有测试。", { size: 13.5, fill: C.ink2 }));

  // Tool card
  out.push(rect(x, 444, w, 56, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(icon("file", x + 14, 462, { size: 16, color: C.muted }));
  out.push(text(x + 40, 466, "read_file", { size: 12, weight: 500, family: F.mono }));
  out.push(text(x + 40, 484, "src/billing/paging.ts · 读取 182 行", { size: 11, fill: C.muted }));
  out.push(pill(x + w - 126, 460, "已完成", "settled", { size: 10.5, h: 20, dot: false }).svg);
  out.push(text(x + w - 16, 477, "查看", { size: 11.5, fill: C.primary, anchor: "end" }));

  // Agent conclusion before approval
  out.push(text(x + 12, 526, "定位到重复游标后，需要运行一次针对性测试确认边界行为。这一步会执行命令：", { size: 13.5, fill: C.ink2 }));

  // Approval card
  const ay = 546;
  const ah = 136;
  out.push(rect(x, ay, w, ah, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(rect(x, ay + 1, 3, ah - 2, { fill: C.attention, rx: 1.5 }));
  out.push(rect(x + 1, ay + 1, w - 2, 34, { fill: C.attentionSoft, rx: 8 }));
  out.push(rect(x + 1, ay + 26, w - 2, 9, { fill: C.attentionSoft }));
  out.push(circle(x + 18, ay + 18, 4, { fill: C.attention }));
  out.push(text(x + 32, ay + 22, "需要你确认", { size: 12.5, weight: 600, fill: C.attention }));
  out.push(text(x + w - 16, ay + 22, "1 小时后过期", { size: 11, fill: C.attention, anchor: "end" }));
  out.push(text(x + 18, ay + 56, "运行命令", { size: 10.5, weight: 500, fill: C.muted }));
  out.push(rect(x + 18, ay + 64, w - 36, 30, { fill: C.code, rx: 6 }));
  out.push(text(x + 30, ay + 83, "pnpm test --filter @atlas/api -- paging", { size: 11.5, fill: C.ink2, family: F.mono }));
  out.push(text(x + 18, ay + 112, "将在独立 worktree 中执行 · 不推送远端 · 仅本次有效", { size: 11, fill: C.muted }));
  out.push(rect(x + w - 152, ay + 98, 60, 28, { fill: C.surface, stroke: C.line, rx: 6 }));
  out.push(tmid(x + w - 140, ay + 98, 28, 11.5, "拒绝", { fill: C.ink2 }));
  out.push(rect(x + w - 84, ay + 98, 66, 28, { fill: C.primary, rx: 6 }));
  out.push(tmid(x + w - 73, ay + 98, 28, 11.5, "批准本次", { fill: C.white, weight: 500 }));

  return out.join("");
}

export function composer() {
  const out = [];
  const x = 472;
  const w = 760;
  const y = 712;
  const h = 168;
  out.push(rect(x, y, w, h, { fill: C.surface, stroke: C.line, rx: 14 }));
  // reference chip
  out.push(rect(x + 14, y + 14, 190, 24, { fill: C.primarySoft, rx: 6 }));
  out.push(icon("file", x + 22, y + 19, { size: 13, color: C.primary }));
  out.push(text(x + 40, y + 30, "src/billing/paging.ts", { size: 11, fill: C.primary, family: F.mono }));
  out.push(text(x + 190, y + 30, "×", { size: 12, fill: C.primary }));
  out.push(text(x + 16, y + 60, "继续描述，或按 ⌘Enter 发送…", { size: 13.5, fill: C.muted }));
  // divider
  out.push(line(x + 14, y + 100, x + w - 14, y + 100, { stroke: C.line }));
  // left actions
  out.push(circle(x + 28, y + 124, 12, { fill: C.surface, stroke: C.line }));
  out.push(icon("plus", x + 22, y + 118, { size: 12, color: C.ink2 }));
  out.push(text(x + 48, y + 129, "@ 引用", { size: 12, fill: C.ink2 }));
  out.push(text(x + 94, y + 129, "$ 技能", { size: 12, fill: C.ink2 }));
  out.push(text(x + 140, y + 129, "/ 命令", { size: 12, fill: C.ink2 }));
  // permission
  out.push(rect(x + 196, y + 112, 96, 26, { fill: C.sunken, rx: 6 }));
  out.push(circle(x + 208, y + 125, 3, { fill: C.attention }));
  out.push(text(x + 218, y + 129, "每次询问", { size: 11.5, fill: C.ink2 }));
  out.push(icon("chevronDown", x + 272, y + 119, { size: 12, color: C.muted }));
  // model (bottom-right, next to send)
  out.push(rect(x + w - 208, y + 112, 144, 26, { fill: "none", stroke: C.line, rx: 6 }));
  out.push(text(x + w - 196, y + 129, "Claude Sonnet 4.5", { size: 11.5, fill: C.ink2 }));
  out.push(icon("chevronDown", x + w - 76, y + 119, { size: 12, color: C.muted }));
  out.push(text(x + w - 216, y + 129, "上下文 18%", { size: 10.5, fill: C.muted, anchor: "end" }));
  // send
  out.push(rect(x + w - 52, y + 110, 32, 32, { fill: C.primary, rx: 8 }));
  out.push(icon("arrowUp", x + w - 44, y + 118, { size: 16, color: C.white, sw: 2 }));
  out.push(text(x + w - 64, y + 156, "⌘Enter", { size: 10, fill: C.muted, anchor: "end" }));
  return out.join("");
}

export function taskWorkspace() {
  return appFrame([taskBase(), taskConversation(), composer()].join(""));
}
