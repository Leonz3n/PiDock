import { useState } from "react";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const types = [
  { key: "skill", label: "Skills", action: "添加技能来源" },
  { key: "mcp", label: "MCP Servers", action: "添加 MCP Server" },
  { key: "extension", label: "Extensions", action: "添加 Extension" },
  { key: "package", label: "Packages", action: "安装扩展包" },
] as const;

type CapabilityType = typeof types[number]["key"];

/** The Host has no production capability inventory; these are navigation categories, not inventory rows. */
export function DesktopCapabilitiesPage() {
  const [type, setType] = useState<CapabilityType>("skill");
  const selected = types.find((item) => item.key === type)!;
  return <div data-testid="desktop-capabilities-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Agent Capabilities</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">能力管理</h1></div>
      <Button type="button" disabled title="Host 尚无能力清单与安装接口"><Icon name="plus" />{selected.action}</Button>
    </div>
    <p className="mt-1.5 text-xs text-muted">Package 负责安装与版本，Skill、MCP 和 Extension 分别展示运行来源、作用域与风险。</p>
    <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-[8px] border border-line bg-paper below-narrow:grid-cols-2" aria-label="能力汇总">
      {types.map((item, index) => <div key={item.key} className={`min-w-0 px-4 py-3 ${index !== 3 ? "border-r border-line" : ""} ${index < 2 ? "below-narrow:border-b" : ""} ${index === 1 ? "below-narrow:border-r-0" : ""}`}>
        <strong className="block text-sm font-medium text-muted">未接线</strong><span className="text-[11px] text-muted">{item.label}</span>
      </div>)}
    </div>
    <div role="tablist" aria-label="能力类型" className="mt-5 flex flex-wrap gap-1 border-b border-line">
      {types.map((item) => <button key={item.key} type="button" role="tab" aria-selected={type === item.key} onClick={() => setType(item.key)} className={`min-h-9 border-b-2 px-3 text-xs ${type === item.key ? "border-[#5773ae] font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}>{item.label}</button>)}
    </div>
    {type === "mcp" && <p className="mt-4 border border-line bg-soft px-3 py-2 text-xs text-muted">Pi 原生不包含 MCP；PiDock 需通过受控桥接 Extension 注册 Server 工具。Prompts 与 Resources 尚未接线。</p>}
    {type === "package" && <p className="mt-4 border border-line bg-soft px-3 py-2 text-xs text-muted">Package 是安装与更新单元，可包含 Skills、Extensions、Prompts 或主题。</p>}
    <section role="tabpanel" aria-label={selected.label} className="mt-4 rounded-[8px] border border-line bg-paper">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3"><h2 className="text-sm font-semibold">{selected.label}</h2><Badge variant="soft">未接线</Badge></div>
      <p className="px-4 py-8 text-center text-xs leading-6 text-muted">Host 尚未提供 {selected.label} 的真实清单、来源及运行时加载状态。此处不展示样例，也不将未知数量显示为零。</p>
    </section>
  </div>;
}
