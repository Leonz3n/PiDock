import { useState } from "react";
import { Badge, Button, Panel } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { InlineNotice, PageIntro, PageTitle, TabRow, ViewLabel } from "../components/Management";
import { capabilityChangeLabel, capabilityKindLabel, capabilityRepairChanged, capabilityRows, isCapabilityEnabled, mcpConnectionLabel, mcpBridgeStatus, packageVersionState, sourceKindLabel, type CapabilityRow } from "../data/capabilityRules";
import type { Capability, CapabilityFailureCode } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

/** Prototype `capabilityLabels` plus this page's 全部 position. */
const KINDS = [
  { value: "all", label: "全部", addLabel: "添加技能来源" },
  { value: "skill", label: "Skills", addLabel: "添加技能来源" },
  { value: "mcp", label: "MCP Servers", addLabel: "添加 MCP Server" },
  { value: "extension", label: "Extensions", addLabel: "添加 Extension" },
  { value: "package", label: "Packages", addLabel: "安装扩展包" },
] as const;

type KindFilter = (typeof KINDS)[number]["value"];

/** Prototype `capabilityRow()`'s per-kind glyph. */
const KIND_ICON: Record<Capability["kind"], IconName> = { skill: "book", mcp: "server", extension: "code", package: "archive" };

/** Prototype `.capability-summary`: the four counts above the tab strip. */
const SUMMARY_CELLS = [
  { kind: "skill", label: "Skills" },
  { kind: "mcp", label: "MCP Servers" },
  { kind: "extension", label: "Extensions" },
  { kind: "package", label: "Packages" },
] as const;

export function CapabilitiesPage() {
  const workspace = useHostStore((state) => state.workspace);
  const setCapabilityEnabled = useHostStore((state) => state.setCapabilityEnabled);
  const retryMcpConnection = useHostStore((state) => state.retryMcpConnection);
  const installCapability = useHostStore((state) => state.installCapability);
  const recheckCapabilities = useHostStore((state) => state.recheckCapabilities);
  const openModal = useUiStore((state) => state.openModal);
  const pushToast = useUiStore((state) => state.pushToast);
  const [kind, setKind] = useState<KindFilter>("all");
  const capabilities = workspace?.capabilities ?? [];
  // No session is attached to this page, so the tier shown is the standard
  // `default` session tier: it is the tier where a capability asking for more
  // is visibly capped, and the row says which tier it assumes.
  const rows = capabilityRows(capabilities, "default").filter((row) => kind === "all" || row.capability.kind === kind);
  const addKind: "skill" | "extension" | "package" | "mcp" = kind === "all" ? "skill" : kind;
  const addLabel = (KINDS.find((entry) => entry.value === kind) ?? KINDS[1]).addLabel;
  const enabledOf = (entries: readonly Capability[]) => `${entries.filter((entry) => isCapabilityEnabled(entry)).length} / ${entries.length} 已启用`;

  const fail = (error: unknown) => pushToast(error instanceof Error ? error.message : String(error));
  const toggle = async (capability: Capability) => {
    // An updatable row is still running, so its button reads 停用 and the click
    // must disable it — not read “not enabled” and enable it again.
    const enabled = isCapabilityEnabled(capability);
    try {
      await setCapabilityEnabled(capability.id, !enabled);
      pushToast(`${capability.name}：变更已提交，如有回合执行中将在结束后生效`);
    } catch (error) {
      fail(error);
    }
  };
  const install = async (capability: Capability) => {
    try {
      const updated = await installCapability(capability.id);
      pushToast(
        updated.pendingChange
          ? `${updated.name}：安装将在当前回合结束后生效`
          : `${updated.name} 已记录安装 ${updated.installedVersion ?? ""}（内存投影）`,
      );
    } catch (error) {
      fail(error);
    }
  };
  const retry = async (capability: Capability) => {
    try {
      await retryMcpConnection(capability.id);
      pushToast(`${capability.name} 已重新连接（内存投影）`);
    } catch (error) {
      fail(error);
    }
  };
  const recheck = async () => {
    const before = new Map(capabilities.map((item) => [item.id, item]));
    try {
      const updated = await recheckCapabilities();
      // A repair is a changed row, not the whole list: the toast must not
      // claim every capability was refreshed when only one recovered.
      const repaired = updated.filter((item) => {
        const previous = before.get(item.id);
        return previous !== undefined && capabilityRepairChanged(previous, item);
      }).length;
      pushToast(`已重新检查来源（内存投影），${repaired} 项能力已刷新`);
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="capabilities-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <ViewLabel>AGENT CAPABILITIES</ViewLabel>
          <PageTitle>能力管理</PageTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void recheck()}>
            <Icon name="refresh" />
            重新检查来源
          </Button>
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "add-capability", kind: addKind })}>
            <Icon name="plus" />
            {addLabel}
          </Button>
        </div>
      </header>

      <PageIntro>Package 负责安装与版本，Skill、MCP 和 Extension 分别展示运行来源、作用域与风险。</PageIntro>

      <div className="capability-summary grid grid-cols-4 rounded-[8px] border border-line bg-paper below-mid:grid-cols-2 below-stack:grid-cols-1">
        {SUMMARY_CELLS.map((cell) => (
          <div key={cell.kind} className="border-r border-line px-[18px] py-[15px] last:border-r-0">
            <strong className="block text-[21px] font-[550] text-ink">{capabilities.filter((entry) => entry.kind === cell.kind).length}</strong>
            <small className="mt-[2px] block text-[11px] text-muted">{cell.label}</small>
          </div>
        ))}
      </div>

      <TabRow
        className="capability-tabs"
        ariaLabel="按类型过滤"
        value={kind}
        onChange={setKind}
        items={KINDS.map((entry) => ({
          value: entry.value,
          label: entry.label,
          badge: enabledOf(entry.value === "all" ? capabilities : capabilities.filter((capability) => capability.kind === entry.value)),
        }))}
      />

      {kind === "mcp" ? (
        <InlineNotice>
          Pi 原生不包含 MCP。PiDock 管理 Server，并通过受控的桥接 Extension 注册工具；首版不承诺兼容 MCP 的 prompts、resources 等其他能力。
        </InlineNotice>
      ) : null}
      {kind === "package" ? (
        <InlineNotice>
          Package 是 npm、git 或本地来源的安装与更新单元；其中可包含多个 Skills、Extensions、Prompts 或主题。
        </InlineNotice>
      ) : null}

      <div className="rounded-md border border-line bg-soft/40 px-3 py-2 text-[11px] text-muted">
        当前数据来自内存投影：来源、版本与连接状态均为夹具，尚未读取真实磁盘来源或建立真实连接。能力声明的权限不会扩大会话权限。
      </div>

      <div className="capability-list overflow-hidden rounded-[8px] border border-line bg-paper">
        {rows.map((row) => (
          <CapabilityRowView
            key={row.capability.id}
            row={row}
            capabilities={capabilities}
            onToggle={() => void toggle(row.capability)}
            onInstall={() => void install(row.capability)}
            onRetry={() => void retry(row.capability)}
          />
        ))}
      </div>

      <p className="note text-[10px] leading-[1.9] text-[#939c9f]">
        启停只改变内存投影里的配置状态；真实的加载、连接与版本切换要等会话空闲边界，磁盘来源与包内容在本页不会被写入。正式产品还需要区分配置已保存、包已安装与运行时已加载。
      </p>

      <Panel title="来源与权限">
        <p className="text-xs text-muted">
          能力来源、适用范围与工具权限分开呈现；技能调用不改变来源或权限。凭据与密钥引用保存在本机私有配置，不随共享模板提交。
        </p>
      </Panel>
    </div>
  );
}

/**
 * One row of the prototype's `.capability-list`: glyph + name + description +
 * meta on the left, the status badge, then the row's actions. The extra lines
 * below the row carry this app's real readings (version state, bridge and
 * connection, the invalid reason, a change waiting for the boundary), which the
 * prototype's mock does not have ([UI 对齐 09] #33).
 */
function CapabilityRowView({
  row,
  capabilities,
  onToggle,
  onInstall,
  onRetry,
}: {
  row: CapabilityRow;
  capabilities: readonly Capability[];
  onToggle: () => void;
  onInstall: () => void;
  onRetry: () => void;
}) {
  const openModal = useUiStore((state) => state.openModal);
  const { capability } = row;
  const version = packageVersionState(capability);
  const bridge = capability.kind === "mcp" ? mcpBridgeStatus(capabilities, capability) : null;
  const change = capabilityChangeLabel(capability);
  return (
    <section
      data-testid={`capability-row-${capability.id}`}
      className="capability-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3.5 border-b border-line px-[15px] py-[13px] last:border-b-0 below-stack:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="capability-main grid min-w-0 grid-cols-[36px_minmax(0,1fr)] items-start gap-3 text-left">
        <span aria-hidden="true" className="capability-icon grid h-9 w-9 place-items-center rounded-[7px] bg-[#f1f3f6] text-[#66758f]">
          <Icon name={KIND_ICON[capability.kind]} />
        </span>
        <span className="min-w-0">
          <strong className="block text-[12px] text-ink">{capability.name}</strong>
          <small className="block truncate text-[11px] text-muted">{capability.description ?? capabilityKindLabel(capability.kind)}</small>
          <span className="capability-meta flex flex-wrap items-center gap-[13px] text-[10px] text-[#8a94a2]">
            <span>{capability.source}</span>
            <span>{sourceKindLabel(row.sourceKind)}</span>
            <span>{capability.scope}</span>
            <span>
              权限 {capability.requestedPermission ?? "未声明"} · 实际为 {row.permission}
            </span>
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {row.ambiguous ? <Badge tone="warn">重名 · 按来源区分</Badge> : null}
        <Badge tone={capability.status === "enabled" ? "accent" : capability.status === "update-available" ? "warn" : "neutral"}>{statusLabel(capability.status)}</Badge>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => openModal({ type: "capability-detail", capabilityId: capability.id })}>
          详情
        </Button>
        <Button size="sm" onClick={onToggle}>
          <Icon name={isCapabilityEnabled(capability) ? "stop" : "play"} />
          {isCapabilityEnabled(capability) ? "停用" : "启用"}
        </Button>
        {version === "not-installed" ? (
          <Button size="sm" variant="primary" onClick={onInstall}>
            <Icon name="down" />
            安装 {capability.availableVersion ?? "此版本"}
          </Button>
        ) : null}
        {version === "update-available" ? (
          <Button size="sm" variant="primary" onClick={onInstall}>
            <Icon name="refresh" />
            更新到 {capability.availableVersion}
          </Button>
        ) : null}
        {capability.kind === "mcp" && bridge && !bridge.ok ? <span className="self-center text-[11px] text-orange">需要 bridge Extension</span> : null}
        {capability.kind === "mcp" && capability.connection?.state !== "connected" && (bridge === null || bridge.ok) ? (
          <Button size="sm" onClick={onRetry}>
            <Icon name="refresh" />
            重试连接
          </Button>
        ) : null}
      </div>

      <div className="col-span-3 below-stack:col-span-2">
        <dl className="mt-2.5 grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11px]">
          <dt className="text-muted">类型</dt>
          <dd>{capabilityKindLabel(capability.kind)}</dd>
          {capability.kind === "package" ? (
            <>
              <dt className="text-muted">安装版本</dt>
              <dd data-testid={`capability-version-${capability.id}`}>
                已安装 {capability.installedVersion ?? "未安装"}
                {capability.availableVersion ? ` · 可用 ${capability.availableVersion}` : ""}
              </dd>
            </>
          ) : null}
          {capability.kind === "mcp" ? (
            <>
              <dt className="text-muted">bridge</dt>
              <dd>{capability.bridge ? capability.bridge.extensionId : "未选择 bridge Extension"}</dd>
              <dt className="text-muted">连接</dt>
              <dd data-testid={`capability-connection-${capability.id}`}>
                {mcpConnectionLabel(capability.connection?.state ?? "disconnected")}
                {capability.connection?.attempts ? ` · 尝试 ${capability.connection.attempts} 次` : ""}
                {capability.authRef ? " · 凭据引用已保存" : ""}
              </dd>
            </>
          ) : null}
          <dt className="text-muted">可用性</dt>
          <dd>{row.provenance === "verified" ? "已在本机验证" : "仅声明（未验证，不代表 SDK 已支持）"}</dd>
        </dl>

        {row.invalid ? (
          <p className="mt-2 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 text-[11px] text-orange">
            {invalidLabel(row.invalid.code)}：{row.invalid.message}
          </p>
        ) : null}

        {change ? <p className="mt-2 text-[11px] text-muted">{change}</p> : null}
      </div>
    </section>
  );
}

function invalidLabel(code: CapabilityFailureCode) {
  return {
    "source-disabled": "来源已停用",
    "source-missing": "来源已移除",
    "resource-missing": "资源缺失",
    "load-failed": "加载失败",
    "bridge-missing": "缺少 bridge Extension",
    "connect-failed": "连接失败",
    "not-installed": "尚未安装",
  }[code];
}

function statusLabel(status: string) {
  return { enabled: "已启用", disabled: "已停用", "update-available": "有可用更新", "pending-review": "待审阅" }[status] ?? status;
}
