import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill, toggle,
  appFrame, sidebar, topbar, field,
} from "../lib.mjs";

function scheduleRow(x, y, w, o) {
  const out = [];
  if (o.selected) {
    out.push(rect(x, y, w, 82, { fill: C.surface, stroke: C.line, rx: 8 }));
    out.push(rect(x, y + 12, 3, 58, { fill: C.primary, rx: 1.5 }));
  }
  out.push(text(x + 18, y + 24, o.name, { size: 13, weight: 500 }));
  out.push(text(x + 18, y + 44, o.project, { size: 10.5, fill: C.muted }));
  out.push(text(x + 18, y + 63, o.rule, { size: 10.5, fill: C.ink2, family: F.mono }));
  out.push(text(x + w - 58, y + 24, o.next ?? "", { size: 10.5, fill: C.muted, anchor: "end" }));
  if (o.state === "已暂停") {
    out.push(pill(x + w - 18, y + 38, "已暂停", "outline", { size: 10, h: 20, align: "right" }).svg);
  } else {
    out.push(toggle(x + w - 54, y + 40, true));
  }
  if (!o.last) out.push(line(x + 18, y + 81.5, x + w - 18, y + 81.5));
  return out.join("");
}

export function schedules() {
  const out = [];
  out.push(sidebar("clock", { projectSelected: false, taskSelected: false, listTitle: "最近任务" }));
  out.push(topbar("定时任务", { primary: "新建定时任务", meta: "应用运行期间执行" }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  out.push(text(x, 120, "定时任务", { size: 30, weight: 600, spacing: -0.5 }));
  out.push(text(x, 146, "在固定任务工作区按规则创建独立会话；退出应用或系统休眠时不执行，也不补跑。", { size: 12, fill: C.muted }));

  // Filters
  out.push(rect(x, 170, 248, 30, { fill: C.sunken, rx: 7 }));
  [["全部", "4", true], ["启用", "3", false], ["已暂停", "1", false]].forEach(([label, count, active], i) => {
    const sx = x + i * 84;
    if (active) out.push(rect(sx, 170, 84, 30, { fill: C.surface, stroke: C.line, rx: 7 }));
    out.push(tmid(sx, 170, 30, 11.5, label, { fill: active ? C.ink : C.muted, weight: active ? 500 : 400, anchor: "middle" }));
    out.push(tmid(sx + 58, 170, 30, 9.5, count, { fill: C.muted, anchor: "middle" }));
  });
  out.push(rect(right - 220, 170, 220, 30, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(icon("search", right - 208, 177, { size: 14, color: C.muted }));
  out.push(text(right - 186, 189, "搜索规则或任务", { size: 11.5, fill: C.muted }));

  // List
  const lx = x;
  const lw = 400;
  out.push(text(lx, 232, "Atlas 结算系统", { size: 11, weight: 600, fill: C.muted, spacing: 0.8 }));
  const rows = [
    { name: "每周仓库改动摘要", project: "Atlas 结算系统 · 修复结算对账", rule: "每周日 18:00 · Asia/Shanghai", next: "11月8日", selected: true },
    { name: "每日风险巡检", project: "Atlas 结算系统 · 发布检查", rule: "周一至周五 17:00", next: "明天" },
    { name: "站会主题准备", project: "基础设施 · 例行维护", rule: "周一至周五 09:15", next: "明天", state: "已暂停", last: true },
  ];
  let ry = 246;
  rows.forEach((r) => {
    out.push(scheduleRow(lx, ry, lw, r));
    ry += 86;
  });

  out.push(text(lx, 538, "基础设施", { size: 11, weight: 600, fill: C.muted, spacing: 0.8 }));
  out.push(scheduleRow(lx, 552, lw, {
    name: "每周依赖升级检查", project: "基础设施 · 依赖维护", rule: "每周五 16:00", next: "11月6日", last: true,
  }));

  // Editor
  const ex = 744;
  const ew = right - ex;
  out.push(rect(ex, 190, ew, 650, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(text(ex + 24, 224, "每周仓库改动摘要", { size: 20, weight: 600, spacing: -0.2 }));
  out.push(text(ex + 24, 246, "Atlas 结算系统 · 修复结算对账", { size: 11, fill: C.muted }));
  out.push(pill(ex + ew - 24, 206, "已启用", "settled", { size: 10.5, h: 22, align: "right" }).svg);
  out.push(text(ex + ew - 24, 253, "下次 11月8日 18:00", { size: 10.5, fill: C.muted, anchor: "end" }));
  out.push(line(ex + 24, 268, ex + ew - 24, 268));

  // Prompt
  out.push(text(ex + 24, 292, "提示词", { size: 12, weight: 500, fill: C.ink2 }));
  out.push(rect(ex + 24, 300, ew - 48, 112, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(text(ex + 36, 322, "汇总过去 7 天 Atlas 结算系统各仓库的改动：", { size: 11.5, fill: C.ink2 }));
  out.push(text(ex + 36, 342, "1. 列出已合并的 PR 与主要变更；", { size: 11.5, fill: C.ink2 }));
  out.push(text(ex + 36, 362, "2. 标出影响结算或导出的改动；", { size: 11.5, fill: C.ink2 }));
  out.push(text(ex + 36, 382, "3. 未提交或未合并的工作单独列出，不要推测完成状态。", { size: 11.5, fill: C.ink2 }));
  out.push(text(ex + 24, 424, "每次触发创建新会话，不继承上次对话。", { size: 10.5, fill: C.muted }));

  // Fields
  out.push(field(ex + 24, 444, 300, "Provider / 模型", "Anthropic 主力 · Claude Sonnet 4.5", { chevron: true }));
  out.push(field(ex + 340, 444, 260, "会话权限", "每次询问", { chevron: true }));

  // Rule
  out.push(text(ex + 24, 510, "重复规则", { size: 12, weight: 500, fill: C.ink2 }));
  out.push(rect(ex + 24, 518, 300, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(text(ex + 36, 538, "每周日 18:00", { size: 12, fill: C.ink }));
  out.push(icon("chevronDown", ex + 304, 527, { size: 14, color: C.muted }));
  out.push(field(ex + 340, 510, 260, "时区", "Asia/Shanghai (UTC+8)", { chevron: true }));

  // Next runs
  out.push(rect(ex + 24, 566, ew - 48, 92, { fill: C.sunken, rx: 8 }));
  out.push(icon("calendar", ex + 38, 580, { size: 15, color: C.ink2 }));
  out.push(text(ex + 60, 592, "接下来 3 次", { size: 11, weight: 600, fill: C.ink2 }));
  out.push(text(ex + 60, 612, "11月8日 周日 18:00    ·    11月15日 周日 18:00    ·    11月22日 周日 18:00", { size: 10.5, fill: C.ink2, family: F.mono }));
  out.push(text(ex + 60, 636, "同一任务已有执行未结束时，本次触发会跳过并记录原因。", { size: 10.5, fill: C.muted }));

  // History
  out.push(text(ex + 24, 690, "最近执行", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(ex + ew - 24, 690, "全部记录", { size: 11, fill: C.primary, anchor: "end" }));
  const hist = [
    ["11月1日 18:00", "已完成", "12m 04s", "查看会话", "settled"],
    ["10月25日 18:00", "失败 · 获取远程记录超时", "1m 12s", "查看原因", "danger"],
  ];
  hist.forEach(([time, state, dur, action, kind], i) => {
    const hy = 704 + i * 38;
    out.push(text(ex + 24, hy + 16, time, { size: 11, fill: C.ink2, family: F.mono }));
    out.push(pill(ex + 132, hy + 2, state, kind, { size: 10, h: 20, dot: false }).svg);
    out.push(text(ex + 372, hy + 16, dur, { size: 10.5, fill: C.muted }));
    out.push(text(ex + ew - 24, hy + 16, action, { size: 10.5, fill: C.primary, anchor: "end" }));
    if (i === 0) out.push(line(ex + 24, hy + 30, ex + ew - 24, hy + 30));
  });

  // Footer
  out.push(line(ex, 792, ex + ew, 792, { stroke: C.line }));
  out.push(text(ex + 24, 822, "修改在会话边界生效；不会重放已执行的操作。", { size: 10.5, fill: C.muted }));
  out.push(rect(ex + ew - 184, 802, 72, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(ex + ew - 172, 802, 32, 11.5, "取消", { fill: C.ink2 }));
  out.push(rect(ex + ew - 100, 802, 76, 32, { fill: C.primary, rx: 7 }));
  out.push(tmid(ex + ew - 88, 802, 32, 11.5, "保存", { fill: C.white, weight: 500 }));

  return appFrame(out.join(""));
}
