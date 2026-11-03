import { useCallback, useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DesktopProvidersPanel } from "./DesktopProvidersPanel";
import { parseProviderStatus, providerCall, type ProviderStatus } from "../data/providerProfile";

/**
 * [PiDock T03] #138 — 能力管理, the single entry for Pi's capabilities.
 *
 * Structure follows the S03 prototype: a 240px vertical nav with exactly three
 * entries (Providers / MCP / Skills), a file-mapping footer that names the real
 * `models.json` path, and the selected pane on the right. Providers is a real
 * management surface (#138); MCP and Skills are honest "尚未接线" states until
 * tickets 150/151 wire them — they show no counts and no sample rows.
 *
 * The old duplicate 模型与 Provider route is gone: this page is the only place
 * a provider is managed, and the task's 选用 is recorded here for the task the
 * user came from (the page keeps that task as its context, Esc returns to it).
 */

type Pane = "providers" | "mcp" | "skills";
const NAV: { key: Pane; label: string; icon: string; hint: string }[] = [
  { key: "providers", label: "Providers", icon: "server", hint: "模型供应商与默认模型" },
  { key: "mcp", label: "MCP", icon: "link", hint: "MCP Servers（尚未接线）" },
  { key: "skills", label: "Skills", icon: "book", hint: "技能来源（尚未接线）" },
];

export function DesktopCapabilitiesPage({
  taskId = null,
  taskName = null,
  onBack,
}: {
  /** The task the user came from: 选用 is recorded on it, and Esc returns to it. */
  taskId?: string | null;
  taskName?: string | null;
  onBack?: () => void;
}) {
  const [pane, setPane] = useState<Pane>("providers");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      setStatus(parseProviderStatus(await providerCall({ op: "list" })));
      setError("");
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof Error ? caught.message : "Provider 配置不可用");
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return <div data-testid="desktop-capabilities-page" className="flex min-h-0 w-full flex-1">
    <nav aria-label="能力管理" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-sidebar px-3 py-4 below-narrow:w-full below-narrow:border-b below-narrow:border-r-0">
      {onBack ? <button type="button" onClick={onBack} className="mb-3 text-left text-[11px] text-muted hover:text-ink">← 返回任务工作区 · Esc</button> : null}
      <p className="px-1 text-[10px] uppercase tracking-[1.4px] text-[#91999f]">能力管理</p>
      <p className="mt-0.5 px-1 text-[11px] text-muted">Pi Agent 核心能力</p>
      <ul className="mt-3 space-y-1">{NAV.map((item) => <li key={item.key}>
        <button type="button" aria-current={pane === item.key ? "page" : undefined} onClick={() => setPane(item.key)}
          className={`flex w-full items-center justify-between rounded-[7px] px-2.5 py-2 text-left text-[12px] ${pane === item.key ? "bg-soft font-medium text-ink" : "text-muted hover:bg-paper hover:text-ink"}`}>
          <span>{item.label}</span>
          {item.key === "providers"
            ? <span className="text-[10px] text-muted">{status === null ? "—" : status.profiles.length}</span>
            : <span className="text-[10px] text-muted">未接线</span>}
        </button>
        <p className="px-2.5 pb-1 text-[10px] text-muted">{item.hint}</p>
      </li>)}</ul>
      <div className="mt-auto border-t border-line pt-3 text-[10px] leading-5 text-muted">
        <p className="font-medium text-ink">底层配置文件映射</p>
        <p data-testid="native-path" className="mt-0.5 break-all font-mono">{status?.nativePath ?? "未知（main 未提供）"}</p>
        <Button type="button" disabled title="打开配置目录的操作尚未接入：这里只列出真实路径">打开配置目录 ↗</Button>
        <p className="mt-1">{status === null ? "" : status.secretsAvailable ? "密钥存储：本机加密（safeStorage）" : "密钥存储：不可用，保存密钥会被拒绝"}</p>
      </div>
    </nav>
    <div className="min-w-0 flex-1 overflow-auto bg-paper px-[34px] py-[26px] below-narrow:px-5">
      {pane === "providers" ? <DesktopProvidersPanel taskId={taskId} taskName={taskName} status={status} error={error}
        onReload={reload} onBack={() => onBack?.()} /> : <NotWired pane={pane} />}
    </div>
  </div>;
}

/**
 * MCP and Skills have no Host inventory yet. Naming what is missing (and what
 * will not be shipped) is the honest state: no invented counts, no sample rows.
 */
function NotWired({ pane }: { pane: Exclude<Pane, "providers"> }) {
  const title = pane === "mcp" ? "MCP Servers" : "Skills";
  return <section data-testid={`capabilities-${pane}`} className="min-w-0">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Agent Capabilities</p>
        <h1 className="mt-1.5 text-[24px] font-semibold text-ink">{title}</h1></div>
      <Badge variant="soft">尚未接线</Badge>
    </header>
    <p className="mt-4 border border-line bg-soft px-3 py-2 text-xs leading-6 text-muted">
      Host 还没有 {title} 的真实清单、来源或运行时加载状态读取操作，因此这里不展示任何行，也不把未知数量显示为零。
      {pane === "mcp"
        ? "Pi 原生不包含 MCP：Server 的注册、工具暴露与审批边界要在受控桥接里先实现（后续工单 150）。"
        : "技能的来源、安装与启停同样需要 Host 侧的真实接口，尚不在本机实现（后续工单 151）。"}
    </p>
    <p className="mt-2 text-[11px] text-muted">在此之前，Provider 管理（左侧第一项）是唯一已接线的能力。</p>
  </section>;
}
