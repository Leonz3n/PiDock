import {
  C, F, W, H,
  text, tmid, rect, line, circle, icon, pill, checkbox,
  appFrame,
} from "../lib.mjs";

function inventoryRow(x, y, w, o) {
  const out = [];
  out.push(line(x, y + 63.5, x + w, y + 63.5));
  out.push(icon(o.icon, x + 4, y + 20, { size: 16, color: C.ink2 }));
  out.push(text(x + 32, y + 24, o.title, { size: 12.5, weight: 500 }));
  out.push(text(x + 32, y + 43, o.meta, { size: 10.5, fill: C.muted }));
  if (o.note) out.push(text(x + 32, y + 58, o.note, { size: 10, fill: o.noteColor ?? C.muted }));
  if (o.control === "keep") {
    out.push(checkbox(x + w - 176, y + 24, true));
    out.push(text(x + w - 154, y + 37, "保留副本", { size: 11, fill: C.ink2 }));
    out.push(checkbox(x + w - 84, y + 24, false));
    out.push(text(x + w - 62, y + 37, "删除副本", { size: 11, fill: C.muted }));
  } else if (o.control === "export") {
    out.push(checkbox(x + w - 176, y + 24, true));
    out.push(text(x + w - 154, y + 37, "导出并移除", { size: 11, fill: C.ink2 }));
    out.push(checkbox(x + w - 84, y + 24, false));
    out.push(text(x + w - 62, y + 37, "仅移除", { size: 11, fill: C.muted }));
  } else if (o.control === "path") {
    out.push(text(x + w - 20, y + 37, "查看", { size: 11, fill: C.primary, anchor: "end" }));
  }
  return out.join("");
}

export function cleanup() {
  const out = [];
  out.push(rect(0, 0, W, H, { fill: C.canvas }));

  // Top bar
  out.push(rect(0, 0, W, 56, { fill: C.canvas }));
  out.push(line(0, 55.5, W, 55.5));
  out.push(rect(20, 13, 30, 30, { fill: C.primary, rx: 9 }));
  out.push(text(35, 34, "π", { size: 20, weight: 600, fill: C.white, anchor: "middle" }));
  out.push(text(60, 34, "PiDock", { size: 14, weight: 600 }));
  out.push(text(132, 34, "/ 清理已归档任务", { size: 13, fill: C.ink2 }));
  out.push(text(W - 124, 34, "步骤 2 / 3", { size: 12, fill: C.muted }));
  out.push(icon("close", W - 60, 20, { size: 18, color: C.ink2 }));

  // Step rail
  out.push(rect(0, 56, 256, H - 56, { fill: C.sidebar }));
  out.push(line(255.5, 56, 255.5, H, { stroke: C.line }));
  out.push(text(28, 100, "归档与清理", { size: 11, weight: 600, fill: C.muted, spacing: 1.1 }));
  const steps = [
    ["1", "选择任务", "只处理已归档任务", "done"],
    ["2", "检查范围", "保留与导出", "active"],
    ["3", "执行并回执", "逐项核验", "todo"],
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
  out.push(text(28, H - 44, "清理不是归档；无法一键撤销。", { size: 10.5, fill: C.muted }));
  out.push(text(28, H - 30, "普通目录的原始文件始终保留。", { size: 10.5, fill: C.muted }));

  // Content
  const x = 304;
  const w = W - 32 - x;
  out.push(text(x, 112, "检查清理范围", { size: 24, weight: 600, spacing: -0.4 }));
  out.push(text(x, 138, "1102-atlas · 修复结算对账的分页边界 · 归档于 3 天前", { size: 11.5, fill: C.muted, family: F.mono }));

  // Warning
  out.push(rect(x, 158, w, 76, { fill: C.dangerSoft, stroke: "#F0CFCB", rx: 9 }));
  out.push(rect(x, 158, 3, 76, { fill: C.danger, rx: 1.5 }));
  out.push(icon("alert", x + 18, 182, { size: 18, color: C.danger, sw: 1.9 }));
  out.push(text(x + 44, 184, "检测到 2 个未提交文件", { size: 13, weight: 600, fill: C.danger }));
  out.push(text(x + 44, 204, "atlas-api · src/billing/paging.ts · src/billing/paging.test.ts", { size: 10.5, fill: C.ink2, family: F.mono }));
  out.push(text(x + 44, 221, "默认保留独立 worktree 副本。删除副本会丢失这些修改，且没有撤销入口。", { size: 10.5, fill: C.muted }));
  out.push(text(x + w - 20, 184, "查看差异", { size: 11, fill: C.primary, anchor: "end" }));

  // Inventory
  out.push(text(x, 268, "清理范围", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(x + w, 268, "任务内受管资源", { size: 10.5, fill: C.muted, anchor: "end" }));
  const iy = 282;
  out.push(rect(x, iy, w, 320, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(inventoryRow(x + 20, iy, w - 40, {
    icon: "branch",
    title: "独立 worktree · 2 个仓库",
    meta: "~/PiDock/atlas/1102-atlas-api · ~/PiDock/atlas/1102-atlas-web",
    note: "包含 2 个未提交文件；保留副本会放在 ~/PiDock/atlas-preserved/1102-atlas",
    noteColor: C.danger,
    control: "keep",
  }));
  out.push(inventoryRow(x + 20, iy + 64, w - 40, {
    icon: "message",
    title: "会话 · 6 个",
    meta: "含 2 个归档会话 · 最近活动 3 天前",
    note: "导出为 Markdown 与 JSON；移除后不再出现在会话列表。",
    control: "export",
  }));
  out.push(inventoryRow(x + 20, iy + 128, w - 40, {
    icon: "file",
    title: "草稿 · 2 个",
    meta: "排查分页重复 · 写回归测试",
    note: "未发送的输入和引用来源会一并导出。",
    control: "export",
  }));
  out.push(inventoryRow(x + 20, iy + 192, w - 40, {
    icon: "clock",
    title: "定时规则 · 1 个",
    meta: "每日风险巡检 · 已暂停",
    note: "执行记录会作为可解释状态保留，不指向其他会话。",
    control: "export",
  }));
  out.push(inventoryRow(x + 20, iy + 256, w - 40, {
    icon: "archive",
    title: "任务登记与来源引用",
    meta: "移除后项目不再被这个已清理任务阻止删除",
    note: "来源仓库和共享目录不会被删除。",
    control: "path",
  }));

  // Export destination
  out.push(text(x, 640, "导出位置", { size: 11, weight: 500, fill: C.ink2 }));
  out.push(rect(x, 648, w, 38, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(icon("folder", x + 12, 659, { size: 15, color: C.muted }));
  out.push(text(x + 34, 671, "~/Documents/PiDock Exports/1102-atlas", { size: 11, fill: C.ink2, family: F.mono }));
  out.push(text(x + w - 20, 671, "更改", { size: 11, fill: C.primary, anchor: "end" }));

  // Estimate
  out.push(text(x, 712, "预计释放 1.8 GB · 估算值；以实际清理结果为准", { size: 10.5, fill: C.muted }));

  // Footer
  out.push(line(0, 824.5, W, 824.5));
  out.push(text(x, 858, "将保留 worktree 副本与导出文件，移除 6 个会话、2 个草稿、1 条定时规则。", { size: 11.5, fill: C.ink2 }));
  out.push(text(x, 876, "来源仓库、普通目录和共享原文件不会被删除。", { size: 10.5, fill: C.muted }));
  out.push(rect(W - 268, 838, 88, 36, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(W - 256, 838, 36, 12, "取消", { fill: C.ink2 }));
  out.push(rect(W - 168, 838, 136, 36, { fill: C.danger, rx: 7 }));
  out.push(tmid(W - 156, 838, 36, 12, "清理并保留副本", { fill: C.white, weight: 500 }));

  return appFrame(out.join(""));
}
