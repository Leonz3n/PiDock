import {
  C, F, W, SIDEBAR,
  text, tmid, rect, line, circle, icon, pill, checkbox, toggle,
  appFrame, sidebar, topbar, field,
} from "../lib.mjs";

function serverRow(x, y, w, o) {
  const out = [];
  if (o.selected) {
    out.push(rect(x, y, w, 82, { fill: C.surface, stroke: C.line, rx: 8 }));
    out.push(rect(x, y + 12, 3, 58, { fill: o.kind === "danger" ? C.danger : C.primary, rx: 1.5 }));
  }
  out.push(rect(x + 16, y + 15, 30, 30, { fill: o.selected ? (o.kind === "danger" ? C.dangerSoft : C.primarySoft) : C.sunken, rx: 7 }));
  out.push(icon("plug", x + 24, y + 23, { size: 15, color: o.selected ? (o.kind === "danger" ? C.danger : C.primary) : C.ink2 }));
  out.push(text(x + 56, y + 29, o.name, { size: 12.5, weight: 500 }));
  out.push(text(x + 56, y + 47, o.meta, { size: 10.5, fill: C.muted }));
  out.push(pill(x + w - 16, y + 14, o.state, o.kind, { size: 9.5, h: 19, align: "right" }).svg);
  out.push(toggle(x + w - 54, y + 44, o.on));
  return out.join("");
}

export function mcp() {
  const out = [];
  out.push(sidebar("settings", { projectSelected: false, taskSelected: false, listTitle: "最近任务" }));
  out.push(topbar("能力与设置", { meta: "配置保存在本机" }));

  const x = SIDEBAR + 32;
  const right = W - 32;

  out.push(text(x, 118, "能力与设置", { size: 28, weight: 600, spacing: -0.5 }));
  out.push(text(x, 144, "Provider、MCP 与 Skills 在本机配置并绑定到真实会话；变更在会话边界生效。", { size: 12, fill: C.muted }));

  // Tabs
  const tabs = [["Provider", false], ["MCP", true], ["Skills", false]];
  let tx = x;
  tabs.forEach(([label, active]) => {
    const w = 24 + label.length * 8.5;
    out.push(text(tx, 184, label, { size: 13, weight: active ? 600 : 400, fill: active ? C.ink : C.ink2 }));
    if (active) out.push(rect(tx, 194, w, 2, { fill: C.primary }));
    tx += w + 34;
  });
  out.push(line(x, 195.5, right, 195.5, { stroke: C.line }));

  // Server list
  const lx = x;
  const lw = 344;
  out.push(text(lx, 228, "MCP 服务器", { size: 11, weight: 600, fill: C.muted, spacing: 0.8 }));
  out.push(text(lx + lw, 228, "+ 添加", { size: 11, fill: C.primary, anchor: "end" }));

  out.push(serverRow(lx, 242, lw, {
    name: "github-mcp", meta: "stdio · 12 个工具", state: "已连接", kind: "settled", selected: true, on: true,
  }));
  out.push(serverRow(lx, 330, lw, {
    name: "playwright-mcp", meta: "stdio · 连接失败", state: "失败", kind: "danger", on: true,
  }));
  out.push(serverRow(lx, 418, lw, {
    name: "filesystem-mcp", meta: "stdio · 4 个工具", state: "已停用", kind: "outline", on: false,
  }));
  out.push(rect(lx, 510, lw, 54, { fill: "none", stroke: C.lineStrong, rx: 8, dash: "4 4" }));
  out.push(icon("plus", lx + 18, 529, { size: 16, color: C.muted }));
  out.push(text(lx + 44, 541, "添加 MCP 服务器", { size: 12, fill: C.ink2 }));
  out.push(text(lx, 596, "连接状态不等于工具已在会话中使用；工具调用仍经过 Host 授权。", { size: 10.5, fill: C.muted }));

  // Detail
  const ex = 688;
  const ew = right - ex;
  out.push(rect(ex, 216, ew, 612, { fill: C.surface, stroke: C.line, rx: 10 }));
  out.push(text(ex + 24, 252, "github-mcp", { size: 20, weight: 600, family: F.mono, spacing: -0.2 }));
  out.push(pill(ex + ew - 24, 232, "已连接", "settled", { size: 10.5, h: 22, align: "right" }).svg);
  out.push(text(ex + 24, 274, "GitHub 官方 MCP · 由 Pi 官方扩展加载", { size: 10.5, fill: C.muted }));
  out.push(icon("dots", ex + ew - 24, 264, { size: 18, color: C.muted }));

  out.push(field(ex + 24, 296, 300, "显示名称", "github-mcp"));
  out.push(field(ex + 340, 296, ew - 364, "传输方式", "stdio", { chevron: true }));

  out.push(text(ex + 24, 362, "启动命令", { size: 12, weight: 500, fill: C.ink2 }));
  out.push(rect(ex + 24, 370, ew - 48, 34, { fill: C.code, rx: 7 }));
  out.push(text(ex + 36, 392, "npx -y @modelcontextprotocol/server-github", { size: 11, fill: C.ink2, family: F.mono }));
  out.push(text(ex + 24, 426, "环境变量", { size: 12, weight: 500, fill: C.ink2 }));
  out.push(text(ex + 112, 426, "GITHUB_TOKEN = ••••••••••••", { size: 11, fill: C.muted, family: F.mono }));
  out.push(text(ex + ew - 24, 426, "编辑", { size: 11, fill: C.primary, anchor: "end" }));

  // Status box
  out.push(rect(ex + 24, 444, ew - 48, 70, { fill: C.sunken, rx: 8 }));
  out.push(circle(ex + 42, 468, 4, { fill: C.settled }));
  out.push(text(ex + 56, 472, "连接正常 · 上次检查 1 分钟前", { size: 11.5, weight: 500 }));
  out.push(text(ex + 56, 492, "12 个工具可用；配置变更在会话边界生效。", { size: 10.5, fill: C.muted }));
  out.push(rect(ex + ew - 132, 462, 96, 28, { fill: C.surface, stroke: C.line, rx: 6 }));
  out.push(tmid(ex + ew - 120, 462, 28, 11, "重新连接", { fill: C.ink2 }));

  // Tools
  out.push(text(ex + 24, 546, "可用工具", { size: 12, weight: 600, fill: C.ink2 }));
  out.push(text(ex + ew - 24, 546, "12 个", { size: 10.5, fill: C.muted, anchor: "end" }));
  const tools = [
    ["search_issues", "搜索仓库 Issue", true],
    ["get_pull_request", "读取 PR 详情与差异", true],
    ["create_pull_request", "创建 PR（需要会话权限）", true],
    ["add_issue_comment", "评论 Issue（需要会话权限）", false],
  ];
  tools.forEach(([name, meta, enabled], i) => {
    const ty = 560 + i * 40;
    out.push(checkbox(ex + 24, ty + 2, enabled));
    out.push(text(ex + 50, ty + 14, name, { size: 11.5, weight: 500, family: F.mono }));
    out.push(text(ex + 50, ty + 30, meta, { size: 10, fill: C.muted }));
    if (i < 3) out.push(line(ex + 24, ty + 36, ex + ew - 24, ty + 36));
  });

  out.push(text(ex + 24, 744, "工具名与参数来自实际连接；连接失败时不会展示伪造的工具列表。", { size: 10.5, fill: C.muted }));
  out.push(line(ex, 760, ex + ew, 760));
  out.push(text(ex + 24, 790, "删除服务器配置不会删除历史会话中的工具结果。", { size: 10.5, fill: C.muted }));
  out.push(text(ex + 24, 797, "删除配置", { size: 11, fill: C.danger }));
  out.push(rect(ex + ew - 184, 776, 72, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(ex + ew - 172, 776, 32, 11.5, "取消", { fill: C.ink2 }));
  out.push(rect(ex + ew - 100, 776, 76, 32, { fill: C.primary, rx: 7 }));
  out.push(tmid(ex + ew - 88, 776, 32, 11.5, "保存", { fill: C.white, weight: 500 }));

  return appFrame(out.join(""));
}
