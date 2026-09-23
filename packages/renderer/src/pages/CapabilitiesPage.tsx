import { useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import { capabilityChangeLabel, capabilityKindLabel, capabilityRows, mcpConnectionLabel, mcpBridgeStatus, packageVersionState, sourceKindLabel, type CapabilityRow } from "../data/capabilityRules";
import type { Capability, CapabilityFailureCode } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

const kinds = [
  { value: "all", label: "全部" },
  { value: "skill", label: "Skills" },
  { value: "extension", label: "Extensions" },
  { value: "package", label: "Packages" },
  { value: "mcp", label: "MCP Servers" },
] as const;

export function CapabilitiesPage() {
  const workspace = useHostStore((state) => state.workspace);
  const setCapabilityEnabled = useHostStore((state) => state.setCapabilityEnabled);
  const retryMcpConnection = useHostStore((state) => state.retryMcpConnection);
  const installCapability = useHostStore((state) => state.installCapability);
  const recheckCapabilities = useHostStore((state) => state.recheckCapabilities);
  const openModal = useUiStore((state) => state.openModal);
  const pushToast = useUiStore((state) => state.pushToast);
  const [kind, setKind] = useState<(typeof kinds)[number]["value"]>("all");
  const capabilities = workspace?.capabilities ?? [];
  // Management view: the tier shown per row is the widest a session can give,
  // so a capability asking for more is visibly capped instead of silently.
  const rows = capabilityRows(capabilities, "auto").filter((row) => kind === "all" || row.capability.kind === kind);
  const addKind: "skill" | "extension" | "package" | "mcp" = kind === "all" ? "skill" : kind;
  const addLabel = { skill: "添加技能来源", extension: "添加 Extension", package: "查看安装来源", mcp: "添加 MCP Server" }[addKind];

  const fail = (error: unknown) => pushToast(error instanceof Error ? error.message : String(error));
  const toggle = async (capability: Capability) => {
    try {
      await setCapabilityEnabled(capability.id, capability.status !== "enabled");
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

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">能力管理</h1>
          <p className="mt-1 text-xs text-muted">
            区分 Pi 原生 Skills、Extensions、Packages，以及 PiDock 通过 bridge Extension 接入的 MCP Servers；Package 负责安装版本，其余视图呈现运行资源与连接。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented ariaLabel="按类型过滤" value={kind} onChange={setKind} options={[...kinds]} />
          <Button size="sm" onClick={() => void recheckCapabilities().then((updated) => pushToast(`已重新检查来源（内存投影），${updated.length} 项能力已刷新`)).catch(fail)}>
            重新检查来源
          </Button>
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "add-capability", kind: addKind })}>
            {addLabel}
          </Button>
        </div>
      </header>

      <div className="rounded-md border border-line bg-soft/40 px-3 py-2 text-[11px] text-muted">
        当前数据来自内存投影：来源、版本与连接状态均为夹具，尚未读取真实磁盘来源或建立真实连接。能力声明的权限不会扩大会话权限。
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((row) => (
          <CapabilityPanel
            key={row.capability.id}
            row={row}
            capabilities={capabilities}
            onToggle={() => void toggle(row.capability)}
            onInstall={() => void install(row.capability)}
            onRetry={() => void retry(row.capability)}
          />
        ))}
      </div>

      <Panel title="来源与权限">
        <p className="text-xs text-muted">
          能力来源、适用范围与工具权限分开呈现；技能调用不改变来源或权限。凭据与密钥引用保存在本机私有配置，不随共享模板提交。
        </p>
      </Panel>
    </div>
  );
}

function CapabilityPanel({
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
  return (
    <Panel
      title={capability.name}
      actions={
        <div className="flex items-center gap-1.5">
          {row.ambiguous ? <Badge tone="warn">重名 · 按来源区分</Badge> : null}
          <Badge tone={capability.status === "enabled" ? "accent" : capability.status === "update-available" ? "warn" : "neutral"}>{statusLabel(capability.status)}</Badge>
        </div>
      }
    >
      <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted">类型</dt>
        <dd>{capabilityKindLabel(capability.kind)}</dd>
        <dt className="text-muted">来源</dt>
        <dd>
          <span className="font-mono text-[11px]">{capability.source}</span>
          <span className="ml-2 text-muted">
            {sourceKindLabel(row.sourceKind)}
          </span>
        </dd>
        <dt className="text-muted">作用域</dt>
        <dd>{capability.scope}</dd>
        {capability.kind === "package" ? (
          <>
            <dt className="text-muted">安装版本</dt>
            <dd>
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
            <dd>
              {mcpConnectionLabel(capability.connection?.state ?? "disconnected")}
              {capability.connection?.attempts ? ` · 尝试 ${capability.connection.attempts} 次` : ""}
              {capability.authRef ? " · 凭据引用已保存" : ""}
            </dd>
          </>
        ) : null}
        <dt className="text-muted">权限</dt>
        <dd>
          声明 {capability.requestedPermission ?? "未声明"} · 实际 {row.permission}
          {capability.requestedPermission !== undefined && row.permission !== capability.requestedPermission ? "（能力不能扩大会话权限）" : ""}
        </dd>
        <dt className="text-muted">可用性</dt>
        <dd>{row.provenance === "verified" ? "已在本机验证" : "仅声明（未验证，不代表 SDK 已支持）"}</dd>
      </dl>

      {row.invalid ? (
        <p className="mt-2 rounded-md border border-orange/35 bg-orange/10 px-3 py-2 text-xs text-orange">
          {invalidLabel(row.invalid.code)}：{row.invalid.message}
        </p>
      ) : null}

      {capabilityChangeLabel(capability) ? <p className="mt-2 text-[11px] text-muted">{capabilityChangeLabel(capability)}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => openModal({ type: "capability-detail", capabilityId: capability.id })}>
          详情
        </Button>
        <Button size="sm" onClick={onToggle}>
          {capability.status === "enabled" || capability.status === "update-available" ? "停用" : "启用"}
        </Button>
        {version === "not-installed" ? (
          <Button size="sm" variant="primary" onClick={onInstall}>
            安装 {capability.availableVersion ?? "此版本"}
          </Button>
        ) : null}
        {version === "update-available" ? (
          <Button size="sm" variant="primary" onClick={onInstall}>
            更新到 {capability.availableVersion}
          </Button>
        ) : null}
        {capability.kind === "mcp" && bridge && !bridge.ok ? <span className="self-center text-[11px] text-orange">需要 bridge Extension</span> : null}
        {capability.kind === "mcp" && capability.connection?.state !== "connected" ? (
          <Button size="sm" onClick={onRetry}>
            重试连接
          </Button>
        ) : null}
      </div>
    </Panel>
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
