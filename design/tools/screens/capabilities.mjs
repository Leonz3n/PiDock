import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill, checkbox,
  appFrame, sidebar, topbar, field,
} from "../lib.mjs";

function providerRow(x, y, w, o) {
  const out = [];
  if (o.selected) {
    out.push(rect(x, y, w, 74, { fill: C.surface, stroke: C.line, rx: 8 }));
    out.push(rect(x, y + 10, 3, 54, { fill: C.primary, rx: 1.5 }));
  }
  out.push(rect(x + 16, y + 14, 30, 30, { fill: o.selected ? C.primarySoft : C.sunken, rx: 7 }));
  out.push(text(x + 31, y + 35, o.letter, { size: 12, weight: 600, fill: o.selected ? C.primary : C.ink2, anchor: "middle" }));
  out.push(text(x + 58, y + 28, o.name, { size: 13, weight: 500 }));
  out.push(text(x + 58, y + 46, o.meta, { size: 10.5, fill: C.muted }));
  out.push(pill(x + w - 16, y + 14, o.state, o.kind, { size: 9.5, h: 19, dot: true, align: "right" }).svg);
  if (o.selected) out.push(text(x + w - 16, y + 58, "默认", { size: 9.5, fill: C.primary, anchor: "end" }));
  return out.join("");
}

export function capabilities() {
  const out = [];
  out.push(sidebar("settings", { projectSelected: false, taskSelected: false, listTitle: "最近任务" }));
  out.push(topbar("能力与设置", { meta: "配置保存在本机" }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  out.push(text(x, 118, "能力与设置", { size: 30, weight: 600, spacing: -0.5 }));
  out.push(text(x, 144, "Provider、MCP 与 Skills 在本机配置并绑定到真实会话；变更在会话边界生效。", { size: 12, fill: C.muted }));

  // Tabs
  const tabs = [["Provider", true], ["MCP", false], ["Skills", false]];
  let tx = x;
  tabs.forEach(([label, active]) => {
    const w = 24 + label.length * 8.5;
    out.push(text(tx, 184, label, { size: 13, weight: active ? 600 : 400, fill: active ? C.ink : C.ink2 }));
    if (active) out.push(rect(tx, 194, w, 2, { fill: C.primary }));
    tx += w + 34;
  });
  out.push(line(x, 195.5, right, 195.5, { stroke: C.line }));

  // Provider list
  const lx = x;
  const lw = 344;
  out.push(text(lx, 228, "Provider 配置", { size: 11, weight: 600, fill: C.muted, spacing: 0.8 }));
  out.push(text(lx + lw, 228, "+ 添加", { size: 11, fill: C.primary, anchor: "end" }));

  out.push(providerRow(lx, 242, lw, {
    name: "Anthropic 主力", meta: "Anthropic · 3 个模型", letter: "A", state: "已连接", kind: "settled", selected: true,
  }));
  out.push(providerRow(lx, 322, lw, {
    name: "OpenAI 备用", meta: "OpenAI · 2 个模型", letter: "O", state: "已连接", kind: "settled",
  }));
  out.push(providerRow(lx, 402, lw, {
    name: "本机 Ollama", meta: "Ollama · 1 个模型", letter: "L", state: "已停用", kind: "outline",
  }));
  out.push(rect(lx, 486, lw, 54, { fill: "none", stroke: C.lineStrong, rx: 8, dash: "4 4" }));
  out.push(icon("plus", lx + 18, 505, { size: 16, color: C.muted }));
  out.push(text(lx + 44, 517, "添加 Provider", { size: 12, fill: C.ink2 }));
  out.push(text(lx, 570, "同一供应商可以有多个配置；会话选择其中一个配置及其模型。", { size: 10.5, fill: C.muted }));

  // Detail
  const ex = 688;
  const ew = right - ex;
  out.push(rect(ex, 216, ew, 612, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(text(ex + 24, 252, "Anthropic 主力", { size: 20, weight: 600, spacing: -0.2 }));
  out.push(pill(ex + ew - 24, 232, "已连接", "settled", { size: 10.5, h: 22, align: "right" }).svg);
  out.push(text(ex + 24, 274, "Anthropic API · 创建于 10月12日", { size: 10.5, fill: C.muted }));
  out.push(icon("dots", ex + ew - 24, 264, { size: 18, color: C.muted }));

  out.push(field(ex + 24, 296, 300, "显示名称", "Anthropic 主力"));
  out.push(field(ex + 340, 296, ew - 364, "服务地址", "https://api.anthropic.com", { mutedValue: false }));

  // Credential
  out.push(text(ex + 24, 362, "认证", { size: 12, weight: 500, fill: C.ink2 }));
  out.push(rect(ex + 24, 370, ew - 48, 36, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(text(ex + 36, 393, "sk-ant-••••••••••••••••", { size: 11.5, fill: C.ink2, family: F.mono }));
  out.push(text(ex + ew - 36, 393, "更换", { size: 11, fill: C.primary, anchor: "end" }));
  out.push(icon("plug", ex + 30, 414, { size: 13, color: C.muted }));
  out.push(text(ex + 48, 426, "凭据仅保存在本机，不进入项目仓库或对话内容。", { size: 10.5, fill: C.muted }));

  // Models
  out.push(line(ex + 24, 448, ex + ew - 24, 448));
  out.push(text(ex + 24, 474, "可用模型", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(ex + ew - 24, 474, "3 个", { size: 10.5, fill: C.muted, anchor: "end" }));
  const models = [
    ["Claude Sonnet 4.5", "默认模型 · 200k 上下文", true],
    ["Claude Opus 4.1", "200k 上下文", true],
    ["Claude Haiku 4.0", "200k 上下文", false],
  ];
  models.forEach(([name, meta, checked], i) => {
    const my = 488 + i * 42;
    out.push(checkbox(ex + 24, my + 3, checked));
    out.push(text(ex + 50, my + 15, name, { size: 12.5, weight: 500, family: F.mono }));
    out.push(text(ex + 50, my + 31, meta, { size: 10.5, fill: C.muted }));
    if (i < 2) out.push(line(ex + 24, my + 38, ex + ew - 24, my + 38));
  });

  // Connection check
  out.push(rect(ex + 24, 622, ew - 48, 66, { fill: C.sunken, rx: 8 }));
  out.push(circle(ex + 42, 646, 4, { fill: C.settled }));
  out.push(text(ex + 56, 650, "连接正常 · 上次检查 2 分钟前", { size: 11.5, weight: 500 }));
  out.push(text(ex + 56, 670, "12 个模型可用；请求会使用本机保存的凭据。", { size: 10.5, fill: C.muted }));
  out.push(rect(ex + ew - 132, 640, 96, 28, { fill: C.surface, stroke: C.line, rx: 6 }));
  out.push(tmid(ex + ew - 120, 640, 28, 11, "测试连接", { fill: C.ink2 }));

  out.push(text(ex + 24, 716, "会话进行中不切换配置；新会话或下一次模型请求前生效。", { size: 10.5, fill: C.muted }));

  // Footer
  out.push(line(ex, 748, ex + ew, 748, { stroke: C.line }));
  out.push(text(ex + 24, 778, "删除配置不会删除历史会话或已记录的用量。", { size: 10.5, fill: C.muted }));
  out.push(rect(ex + ew - 184, 758, 72, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(ex + ew - 172, 758, 32, 11.5, "取消", { fill: C.ink2 }));
  out.push(rect(ex + ew - 100, 758, 76, 32, { fill: C.primary, rx: 7 }));
  out.push(tmid(ex + ew - 88, 758, 32, 11.5, "保存", { fill: C.white, weight: 500 }));

  return appFrame(out.join(""));
}
