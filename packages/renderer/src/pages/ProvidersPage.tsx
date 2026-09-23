import { useState } from "react";
import { Badge, Button, Panel } from "../components/ui";
import { describeContextWindow, describeProviderStatus, formatTokens } from "../data/providerState";
import type { ProviderProfile, ProviderStatusView } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

const AVAILABILITY_LABEL: Record<ProviderStatusView["availability"], string> = {
  available: "可用",
  disabled: "已停用",
  missing: "配置不存在",
  "model-unavailable": "模型不可用",
};

export function ProvidersPage() {
  const workspace = useHostStore((state) => state.workspace);
  const providers = workspace?.providers ?? [];
  const openModal = useUiStore((state) => state.openModal);
  const removeProvider = useHostStore((state) => state.removeProvider);
  const setProviderEnabled = useHostStore((state) => state.setProviderEnabled);
  const syncProviderModels = useHostStore((state) => state.syncProviderModels);
  const pushToast = useUiStore((state) => state.pushToast);
  // One sync report per provider: candidates are only a suggestion list, so the
  // report says which outcome happened (success/empty/failure/unsupported) and
  // the configured rows are never touched by it.
  const [syncReports, setSyncReports] = useState<Record<string, { status: string; message: string; count: number }>>({});

  const sync = async (provider: ProviderProfile) => {
    const view = await syncProviderModels(provider.id);
    setSyncReports((reports) => ({ ...reports, [provider.id]: { status: view.status, message: view.message, count: view.candidates.length } }));
    pushToast(view.message);
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">模型与 Provider</h1>
          <p className="mt-1 text-xs text-muted">
            同一供应商可以保存多个独立配置；会话选择其中一个配置及其模型，上下文占用与 Token 消耗分开记录。
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "provider-edit" })}>
          添加 Provider
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {providers.map((provider) => {
          const status = describeProviderStatus(provider);
          const report = syncReports[provider.id];
          return (
            <Panel
              key={provider.id}
              title={provider.name}
              actions={
                <div className="flex items-center gap-1.5">
                  <Badge tone={provider.enabled ? "accent" : "neutral"}>{provider.enabled ? "已启用" : "已停用"}</Badge>
                  <Badge>{provider.protocol}</Badge>
                </div>
              }
            >
              <p className="font-mono text-[11px] text-muted">{provider.baseUrl}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted" data-testid={`provider-status-${provider.id}`}>
                <span>可用性：{AVAILABILITY_LABEL[status.availability]}</span>
                <span>认证：{status.auth === "reference" ? "引用已配置" : "未配置引用"}</span>
                <span>模型 {provider.models.length} 个</span>
              </p>
              {status.availabilityMessage ? <p className="mt-1 text-[11px] text-orange">{status.availabilityMessage}</p> : null}
              {status.issues.length > 0 ? (
                <ul className="mt-1 list-disc pl-4 text-[11px] text-orange" data-testid={`provider-issues-${provider.id}`}>
                  {status.issues.map((issue) => (
                    <li key={`${issue.code}-${issue.field}`}>
                      {issue.field}：{issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="pb-1.5">模型</th>
                    <th className="pb-1.5">上下文窗口</th>
                    <th className="pb-1.5">最大输出</th>
                    <th className="pb-1.5">能力 / 推理</th>
                  </tr>
                </thead>
                <tbody>
                  {provider.models.map((model) => {
                    return (
                      <tr key={model.id} className="border-t border-line">
                        <td className="py-1.5">
                          {model.name ?? model.id}
                          {model.name ? <small className="ml-1.5 text-muted">{model.id}</small> : null}
                        </td>
                        <td className="py-1.5">
                          {formatTokens(model.contextWindow * 1000)}
                          <small className="ml-1.5 text-muted">{describeContextWindow(model).label}</small>
                        </td>
                        <td className="py-1.5">{model.maxOutput !== undefined ? formatTokens(model.maxOutput * 1000) : "未声明"}</td>
                        <td className="py-1.5 text-muted">
                          {model.supportsImages ? "支持图片" : "不支持图片"}
                          {model.thinking === undefined || model.thinking.mode === "auto"
                            ? " · 推理跟随目录"
                            : model.thinking.mode === "none"
                              ? " · 不支持推理"
                              : ` · 推理 ${model.thinking.levels.join("/")}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {report ? (
                <p
                  className={`mt-2 text-[11px] ${report.status === "success" ? "text-muted" : "text-orange"}`}
                  role="status"
                  data-testid={`provider-sync-${provider.id}`}
                >
                  {report.message}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => openModal({ type: "provider-edit", providerId: provider.id })}>
                  编辑
                </Button>
                <Button size="sm" onClick={() => void sync(provider)}>
                  同步模型列表
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    await setProviderEnabled(provider.id, !provider.enabled);
                    pushToast(provider.enabled ? "已停用该配置；引用它的会话会提示配置不可用" : "已启用该配置");
                  }}
                >
                  {provider.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await removeProvider(provider.id);
                    pushToast("已移除配置；会话与历史仍显示原归属并提示配置不可用，不会自动改选其他账户");
                  }}
                >
                  删除
                </Button>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel title="上下文与压缩规则">
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
          <li>上下文超过目标模型窗口时禁止切换，候选置灰并显示未格式化的占用与上限 Tokens。</li>
          <li>窗口未知或占用待更新时不会按零占用放行；模型切换后窗口与预估剩余量随当前模型变化。</li>
          <li>上下文压缩或切换模型不清零已有 Token 消耗，只改变后续请求占用；压缩后占用标记为待更新。</li>
          <li>推理档位跟随模型配置；模型未声明档位时不会虚构可选档位，旧偏好失效会回退到模型默认。</li>
          <li>凭据只保存本机私有配置的引用，不写入共享模板、对话与普通日志。</li>
        </ul>
      </Panel>
    </div>
  );
}
