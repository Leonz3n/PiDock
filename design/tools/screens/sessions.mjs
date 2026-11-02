import {
  C, F, W, H,
  text, tmid, rect, line, circle, icon, pill,
  appFrame, scrim,
} from "../lib.mjs";
import { taskBase, taskConversation, composer } from "./task.mjs";

function sessionRow(x, y, w, o) {
  const out = [];
  if (o.selected) {
    out.push(rect(x, y, w, 78, { fill: C.primarySoft, rx: 8 }));
    out.push(rect(x, y + 12, 3, 54, { fill: C.primary, rx: 1.5 }));
  }
  out.push(text(x + 18, y + 26, o.title, { size: 13, weight: o.selected ? 600 : 500, fill: o.readOnly ? C.muted : C.ink }));
  out.push(pill(x + 18, y + 40, o.state, o.kind, { size: 9.5, h: 20, dot: true }).svg);
  out.push(text(x + 116, y + 54, o.meta, { size: 10.5, fill: C.muted }));
  out.push(text(x + w - 18, y + 26, o.time, { size: 10.5, fill: C.muted, anchor: "end" }));
  if (o.unread) out.push(circle(x + w - 22, y + 45, 3.5, { fill: C.primary }));
  out.push(icon("chevronRight", x + w - 40, y + 34, { size: 13, color: C.lineStrong }));
  return out.join("");
}

export function sessions() {
  const out = [];
  out.push(taskBase());
  out.push(taskConversation());
  out.push(composer());
  out.push(scrim());

  const x = 700;
  const w = W - x;
  out.push(rect(x, 0, w, H, { fill: C.surface }));
  out.push(line(x + 0.5, 0, x + 0.5, H, { stroke: C.line }));
  out.push(text(x + 32, 66, "全部会话", { size: 20, weight: 600, spacing: -0.3 }));
  out.push(text(x + 32, 88, "修复结算对账的分页边界 · 3 个进行中，2 个已归档", { size: 11, fill: C.muted }));
  out.push(icon("close", x + w - 36, 48, { size: 18, color: C.muted }));

  out.push(rect(x + 32, 108, w - 64, 34, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(icon("search", x + 44, 117, { size: 15, color: C.muted }));
  out.push(text(x + 66, 130, "搜索会话名称或最近消息", { size: 11.5, fill: C.muted }));

  out.push(text(x + 32, 174, "进行中", { size: 10.5, weight: 600, fill: C.muted, spacing: 1 }));
  out.push(text(x + w - 32, 174, "3 个", { size: 10.5, fill: C.muted, anchor: "end" }));

  const active = [
    { title: "排查分页重复", state: "执行中", kind: "running", meta: "12 条消息 · 正在读取 paging.ts", time: "2 分钟前", selected: true, unread: true },
    { title: "写回归测试", state: "空闲", kind: "outline", meta: "8 条消息 · 草稿已保留", time: "昨天 18:20" },
    { title: "导出接口核对", state: "已完成", kind: "settled", meta: "21 条消息 · 结果未读", time: "今天 10:42", unread: true },
  ];
  active.forEach((s, i) => {
    out.push(sessionRow(x + 20, 188 + i * 84, w - 40, s));
    if (i < 2) out.push(line(x + 38, 188 + i * 84 + 82, x + w - 38, 188 + i * 84 + 82, { stroke: C.line }));
  });

  out.push(text(x + 32, 462, "已归档", { size: 10.5, weight: 600, fill: C.muted, spacing: 1 }));
  out.push(text(x + w - 32, 462, "2 个", { size: 10.5, fill: C.muted, anchor: "end" }));
  const archived = [
    { title: "初始排查", state: "已归档", kind: "outline", meta: "14 条消息 · 归档于 3 天前", time: "10月30日", readOnly: true },
    { title: "错误码讨论", state: "已归档", kind: "outline", meta: "6 条消息 · 归档于 10月28日", time: "10月28日", readOnly: true },
  ];
  archived.forEach((s, i) => {
    out.push(sessionRow(x + 20, 476 + i * 84, w - 40, s));
    if (i === 0) out.push(line(x + 38, 558, x + w - 38, 558, { stroke: C.line }));
  });

  out.push(rect(x + 32, 676, w - 64, 1, { fill: C.line }));
  out.push(text(x + 32, 706, "会话归档不是任务归档；归档后仍可查看，但发送前需要恢复。", { size: 10.5, fill: C.muted }));
  out.push(rect(x + 32, 730, w - 64, 40, { fill: C.primary, rx: 8 }));
  out.push(icon("plus", x + 316, 741, { size: 15, color: C.white }));
  out.push(tmid(x + 338, 730, 40, 12, "新建会话", { fill: C.white, weight: 500 }));
  out.push(text(x + 32, 800, "新会话使用同一个任务工作区，但不会继承当前对话上下文。", { size: 10.5, fill: C.muted }));
  out.push(text(x + 32, 834, "全部会话支持名称搜索、进行中/已归档分组和最近活动排序。", { size: 10.5, fill: C.muted }));

  return appFrame(out.join(""));
}
