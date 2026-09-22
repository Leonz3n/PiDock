import { useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
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
  const capabilities = workspace?.capabilities ?? [];
  const setCapabilityEnabled = useHostStore((state) => state.setCapabilityEnabled);
  const openModal = useUiStore((state) => state.openModal);
  const [kind, setKind] = useState<(typeof kinds)[number]["value"]>("all");
  const items = capabilities.filter((item) => kind === "all" || item.kind === kind);
  const addKind: "skill" | "extension" | "package" | "mcp" = kind === "all" ? "skill" : kind;
  const addLabel = { skill: "添加技能来源", extension: "添加 Extension", package: "安装扩展包", mcp: "添加 MCP Server" }[addKind];

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
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "add-capability", kind: addKind })}>
            {addLabel}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((capability) => (
          <Panel
            key={capability.id}
            title={capability.name}
            actions={<Badge tone={capability.status === "enabled" ? "accent" : capability.status === "update-available" ? "warn" : "neutral"}>{statusLabel(capability.status)}</Badge>}
          >
            <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted">类型</dt>
              <dd>{typeLabel(capability.kind)}</dd>
              <dt className="text-muted">来源</dt>
              <dd className="font-mono text-[11px]">{capability.source}</dd>
              <dt className="text-muted">作用域</dt>
              <dd>{capability.scope}</dd>
            </dl>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => openModal({ type: "capability-detail", capabilityId: capability.id })}>
                详情
              </Button>
              <Button size="sm" onClick={() => void setCapabilityEnabled(capability.id, capability.status !== "enabled")}>
                {capability.status === "enabled" ? "停用" : "启用"}
              </Button>
              {capability.status === "update-available" ? (
                <Button size="sm" variant="primary" onClick={() => void setCapabilityEnabled(capability.id, true)}>
                  更新到最新版本
                </Button>
              ) : null}
            </div>
          </Panel>
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

function typeLabel(kind: string) {
  return { skill: "Pi Skill", extension: "Extension", package: "Package", mcp: "MCP Server（bridge）" }[kind] ?? kind;
}

function statusLabel(status: string) {
  return { enabled: "已启用", disabled: "已停用", "update-available": "有可用更新", "pending-review": "待审阅" }[status] ?? status;
}
