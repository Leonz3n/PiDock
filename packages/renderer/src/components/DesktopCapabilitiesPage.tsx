import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { DesktopProvidersPanel } from "./DesktopProvidersPanel";
import { DesktopSkills } from "./DesktopSkills";
import { DesktopMcpPanel } from "./DesktopMcpPanel";
import { parseProviderStatus, providerCall, type ProviderStatus } from "../data/providerProfile";

/**
 * [PiDock T03] #138 — 能力管理, the single entry for Pi's capabilities.
 *
 * Structure follows the S03/S09 prototype: a 240px vertical nav with exactly
 * three entries (Providers / MCP / Skills), a file-mapping footer that names the
 * real `models.json` path, and the selected pane on the right. Providers (#138)
 * and MCP (issue 150) are real management surfaces: MCP lists Pi's native
 * `mcp.json`, edits only the `pidock-mcp-<uuid>` namespace, tests the real
 * connection and states that a save applies to the next session. Skills is the real source scan (issue 151). No Extensions page.
 *
 * Skills reads the same main-owned real source scan used by new SDK sessions.
 * Sidebar counts stay unknown until their native list has actually been read.
 */

type Pane = "providers" | "mcp" | "skills";
const NAV: { key: Pane; label: string; icon: IconName; hint: string }[] = [
  { key: "providers", label: "Providers", icon: "server", hint: "模型供应商与默认模型" },
  { key: "mcp", label: "MCP", icon: "link", hint: "Pi 原生 mcp.json · 工具与审批" },
  { key: "skills", label: "Skills", icon: "book", hint: "本地技能来源与 SKILL.md" },
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
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState<Pane>("providers");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState("");
  // `null` = the MCP list could not be read (never rendered as zero).
  const [skillsCount, setSkillsCount] = useState<number | null>(null);
  const onSkillsCount = useCallback((count: number | null) => setSkillsCount(count), []);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const onMcpCount = useCallback((count: number | null) => setMcpCount(count), []);

  // With a task the list also reports that task's live selection (configured /
  // pending / credential-missing); without one it is the global config list.
  const reload = useCallback(async () => {
    try {
      setStatus(parseProviderStatus(await providerCall({ op: "list", ...(taskId === null ? {} : { taskId }) })));
      setError("");
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof Error ? caught.message : "Provider 配置不可用");
    }
  }, [taskId]);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("[data-form-open=true]") && !event.defaultPrevented && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) onBack?.(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onBack]);
  return <div data-testid="desktop-capabilities-page" className="management-window flex h-screen min-h-0 w-full text-ink">
    <nav aria-label="能力管理" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-sidebar px-3 py-4 ">
      {onBack ? <button type="button" aria-label="返回任务工作区" onClick={onBack} className="mb-3 flex h-7 items-center rounded-md border border-line bg-paper px-2.5 text-left text-[11px] text-ink">← 返回任务工作区 · Esc</button> : null}
      <p className="flex items-center gap-2 px-1 py-2 text-[14px] font-semibold"><Icon name="blocks" />能力管理</p>
      <p className="mt-0.5 px-1 text-[11px] text-muted">Pi Agent 核心能力</p>
      <ul className="mt-1 flex flex-col gap-1">{NAV.map((item) => <li key={item.key}>
        <button type="button" aria-current={pane === item.key ? "page" : undefined} onClick={() => setPane(item.key)}
          className={`flex w-full items-center justify-between h-[30px] rounded-[7px] px-2.5 text-left text-[12px] ${pane === item.key ? "bg-soft font-medium text-ink" : "text-muted hover:bg-paper hover:text-ink"}`}>
          <span className="flex items-center gap-2"><Icon name={item.icon} />{item.label}</span>
          {item.key === "providers"
            ? <span className="text-[10px] text-muted">{status === null ? "—" : status.profiles.length}</span>
            : item.key === "mcp"
              ? <span className="text-[10px] text-muted">{mcpCount === null ? "—" : mcpCount}</span>
              : <span className="text-[10px] text-muted">{skillsCount ?? "—"}</span>}
        </button>
      </li>)}</ul>
      <div className="mt-auto rounded-md bg-bg p-2 text-[10px] leading-4 text-muted">
        <p className="font-medium text-ink">底层配置文件映射</p>
        <p data-testid="native-path" className="mt-0.5 break-all font-mono">{status?.nativePath ?? "未知（main 未提供）"}</p>
        <p className="mt-1">{status === null ? "" : status.secretsAvailable ? "密钥存储：本机加密（safeStorage）" : "密钥存储：不可用，保存密钥会被拒绝"}</p>
      </div>
    </nav>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header data-testid="management-header" className="flex h-[52px] shrink-0 items-center border-b border-line bg-paper px-8 text-[14px] font-semibold">
        <div ref={setHeaderSlot} className="flex min-w-0 items-center" />
        {pane === "providers" ? null : pane === "mcp" ? "MCP / Skills 管理 · MCP 工具服务" : "MCP / Skills 管理 · Skills 技能库"}
      </header>
      <div data-testid="management-content" className="capability-content min-h-0 min-w-0 flex-1 overflow-auto px-12 py-6 below-narrow:px-5">
      {pane === "providers" ? <DesktopProvidersPanel headerSlot={headerSlot} taskId={taskId} taskName={taskName} status={status} error={error}
        onReload={reload} onBack={() => onBack?.()} />
        : pane === "mcp" ? <DesktopMcpPanel onCount={onMcpCount} />
        : <DesktopSkills onCount={onSkillsCount} />}
      </div>
    </div>
  </div>;
}

