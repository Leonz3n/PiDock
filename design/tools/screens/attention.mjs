import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill,
  appFrame, sidebar, topbar,
} from "../lib.mjs";

function groupHeader(x, y, w, title, count, kind) {
  const color = kind === "attention" ? C.attention : kind === "danger" ? C.danger : C.settled;
  return [
    circle(x + 4, y + 7, 3.5, { fill: color }),
    text(x + 16, y + 11, title, { size: 11.5, weight: 600, fill: color }),
    text(x + w, y + 11, `${count} 项`, { size: 10.5, fill: C.muted, anchor: "end" }),
  ].join("");
}

function inboxRow(x, y, w, o) {
  const out = [];
  out.push(rect(x, y, w, 72, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(rect(x, y + 10, 3, 52, { fill: o.kind === "attention" ? C.attention : o.kind === "danger" ? C.danger : C.primary, rx: 1.5 }));
  out.push(icon(o.icon ?? "message", x + 20, y + 20, { size: 16, color: o.kind === "attention" ? C.attention : o.kind === "danger" ? C.danger : C.primary }));
  out.push(text(x + 48, y + 24, o.title, { size: 13, weight: 500 }));
  out.push(text(x + 48, y + 42, o.meta, { size: 10.5, fill: C.muted }));
  out.push(text(x + 48, y + 59, o.detail, { size: 10.5, fill: C.ink2, family: o.mono ? F.mono : F.sans }));
  out.push(text(x + w - 124, y + 40, o.time, { size: 10.5, fill: C.muted, anchor: "end" }));
  out.push(rect(x + w - 114, y + 20, 96, 32, { fill: o.primary ? C.primary : C.surface, stroke: o.primary ? "none" : C.line, rx: 7 }));
  out.push(tmid(x + w - 102, y + 20, 32, 11.5, o.action, { fill: o.primary ? C.white : C.ink2, weight: 500 }));
  return out.join("");
}

export function attention() {
  const out = [];
  out.push(sidebar("inbox", { projectSelected: false, taskSelected: false, listTitle: "最近任务" }));
  out.push(topbar("需要处理", { meta: "6 项未处理" }));

  const x = SIDEBAR + 32;
  const right = W - 32;
  const w = right - x;

  out.push(text(x, 120, "需要处理", { size: 30, weight: 600, spacing: -0.5 }));
  out.push(text(x, 146, "汇总所有项目中等待确认、执行失败和已完成未读的会话；处理后从列表移除。", { size: 12, fill: C.muted }));

  // Filters
  out.push(rect(x, 168, 370, 30, { fill: C.sunken, rx: 7 }));
  [["全部", "6", true], ["等待确认", "2", false], ["失败", "1", false], ["已完成", "2", false]].forEach(([label, count, active], i) => {
    const widths = [78, 112, 80, 100];
    const sx = x + widths.slice(0, i).reduce((a, b) => a + b, 0);
    if (active) out.push(rect(sx, 168, widths[i], 30, { fill: C.surface, stroke: C.line, rx: 7 }));
    out.push(tmid(sx, 168, 30, 11, label, { fill: active ? C.ink : C.muted, weight: active ? 500 : 400, anchor: "middle" }));
    out.push(tmid(sx + widths[i] - 22, 168, 30, 9.5, count, { fill: C.muted, anchor: "middle" }));
  });
  out.push(text(right, 188, "全部标记已读", { size: 11.5, fill: C.primary, anchor: "end" }));

  // Waiting for approval
  out.push(groupHeader(x, 226, w, "等待确认", 2, "attention"));
  out.push(inboxRow(x, 242, w, {
    title: "修复结算对账的分页边界",
    meta: "Atlas 结算系统 · 排查分页重复 · 等待 3 分钟",
    detail: "运行命令 · pnpm test --filter @atlas/api -- paging",
    time: "12 分钟后过期",
    state: "等待确认",
    kind: "attention",
    action: "去批准",
    primary: true,
    mono: true,
  }));
  out.push(inboxRow(x, 322, w, {
    title: "升级 Provider 配置",
    meta: "基础设施 · 更新依赖 · 等待 8 分钟",
    detail: "写入文件 · ~/work/infra/package.json",
    time: "1 小时后过期",
    state: "等待确认",
    kind: "attention",
    action: "去批准",
    primary: true,
  }));

  // Failed
  out.push(groupHeader(x, 412, w, "执行失败", 1, "danger"));
  out.push(inboxRow(x, 428, w, {
    title: "生成 v0.2 发布说明",
    meta: "Atlas 结算系统 · 发布说明 · 失败 4 分钟前",
    detail: "读取文件被拒绝 · ~/work/design-tokens/changelog.md",
    time: "4 分钟前",
    state: "失败",
    kind: "danger",
    action: "查看原因",
    icon: "alert",
  }));

  // Completed unread
  out.push(groupHeader(x, 518, w, "已完成未读", 2, "settled"));
  out.push(inboxRow(x, 534, w, {
    title: "核对导出接口的错误码",
    meta: "Atlas 结算系统 · 导出接口核对 · 完成于 10:42",
    detail: "结果已保留在会话中；查看后清除未读。",
    time: "今天 10:42",
    state: "已完成",
    kind: "settled",
    action: "查看结果",
    icon: "check",
  }));
  out.push(inboxRow(x, 614, w, {
    title: "归档旧迁移脚本",
    meta: "个人脚本 · 归档检查 · 完成于昨天 18:20",
    detail: "2 个脚本已确认无引用；未删除任何原始目录。",
    time: "昨天 18:20",
    state: "已完成",
    kind: "settled",
    action: "查看结果",
    icon: "check",
  }));

  // Skipped schedule
  out.push(groupHeader(x, 704, w, "定时执行跳过", 1, "settled"));
  out.push(inboxRow(x, 720, w, {
    title: "每日风险巡检",
    meta: "基础设施 · 定时任务 · 触发于今天 17:00",
    detail: "同一任务仍有执行未结束，本次触发已跳过并记录。",
    time: "今天 17:00",
    state: "已跳过",
    kind: "outline",
    action: "查看记录",
    icon: "clock",
  }));

  out.push(text(x, 830, "失败与等待确认需要处理后移除；已完成条目在查看结果后清除未读。", { size: 10.5, fill: C.muted }));

  return appFrame(out.join(""));
}
