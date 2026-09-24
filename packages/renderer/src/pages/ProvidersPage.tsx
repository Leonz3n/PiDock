import { useState } from "react";
import { Badge, Button, Panel } from "../components/ui";
import { Icon } from "../components/Icon";
import { Card, CardGrid, PageIntro, PageTitle, ViewLabel } from "../components/Management";
import { describeContextWindow, describeProviderStatus, formatTokens, protocolLabel } from "../data/providerState";
import type { ProviderProfile, ProviderStatusView } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

const AVAILABILITY_LABEL: Record<ProviderStatusView["availability"], string> = {
  available: "可用",
  disabled: "已停用",
  missing: "配置不存在",
  "model-unavailable": "模型不可用",
};

/**
 * The prototype's `.provider-symbol` glyphs (`providersPage()`):
 * `['✳','◎','↗'][i]`. Decorative, so it follows the card's position rather than
 * any provider field — the same three-glyph cycle the prototype draws.
 */
const PROVIDER_SYMBOLS = ["✳", "◎", "↗"];

/** Prototype `windowLabel(n)` in the page's own unit (a model window is in k). */
function windowChipLabel(k: number): string {
  return k > 0 ? `${k}k` : "未知";
}

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
    <div className="flex flex-col gap-4" data-testid="providers-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <ViewLabel>MODELS</ViewLabel>
          <PageTitle>模型与 Provider</PageTitle>
        </div>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "provider-edit" })}>
          <Icon name="plus" />
          添加 Provider
        </Button>
      </header>

      <PageIntro>保存多个服务账号，在对话中按需切换。凭据只保存在本机。</PageIntro>

      <CardGrid cols={3}>
        {providers.map((provider, index) => {
          const status = describeProviderStatus(provider);
          const report = syncReports[provider.id];
          return (
            // A real element (`section`) so a card can be scoped like the
            // prototype's `.provider-card` block without relying on class names.
            <section
              key={provider.id}
              aria-label={provider.name}
              data-testid={`provider-card-${provider.id}`}
              className="provider-card rounded-[9px] border border-line bg-paper p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <div
                  aria-hidden="true"
                  className="provider-symbol grid h-[35px] w-[35px] place-items-center rounded-[9px] bg-[#f1eee8] text-[18px] font-semibold text-[#a8895f]"
                >
                  {PROVIDER_SYMBOLS[index % PROVIDER_SYMBOLS.length]}
                </div>
                <Badge tone={provider.enabled ? "accent" : "neutral"}>{provider.enabled ? "已启用" : "已停用"}</Badge>
              </div>

              <h3 className="mt-4 text-[13px] font-[650] text-ink">{provider.name}</h3>
              {/* [UI 对齐 09] #33 review P2-7: the prototype prints the protocol's
                  display name; the wire id stays the stored value. */}
              <div className="mt-[7px]" data-testid={`provider-protocol-${provider.id}`}>
                <Badge>{protocolLabel(provider.protocol)}</Badge>
              </div>
              <p className="mono my-3 font-mono text-[11px] text-[#94979c] [overflow-wrap:anywhere]" data-testid={`provider-endpoint-${provider.id}`}>
                {provider.baseUrl}
              </p>

              {/* Chips are a single text node per model (`name · window ·
                  图片`), so the per-model rows below stay the only elements
                  that match a bare model name. */}
              <div className="provider-model-chips mb-2 flex flex-wrap gap-[5px]" data-testid={`provider-models-${provider.id}`}>
                {provider.models.map((model) => (
                  <Badge key={model.id}>
                    {model.name ?? model.id} · {windowChipLabel(model.contextWindow)}
                    {model.supportsImages ? " · 图片" : ""}
                  </Badge>
                ))}
              </div>

              <small className="text-[11px] text-muted" data-testid={`provider-credentials-${provider.id}`}>
                {provider.models.length} 个模型 · {status.auth === "reference" ? "凭据已设置" : "凭据未设置"}
              </small>

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

              <table className="mt-3 w-full text-[11px]">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="pb-1.5 font-normal">模型</th>
                    <th className="pb-1.5 font-normal">上下文窗口</th>
                    <th className="pb-1.5 font-normal">最大输出</th>
                    <th className="pb-1.5 font-normal">能力 / 推理</th>
                  </tr>
                </thead>
                <tbody>
                  {provider.models.map((model) => (
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
                  ))}
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

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => openModal({ type: "provider-edit", providerId: provider.id })}>
                  <Icon name="settings" />
                  编辑
                </Button>
                <Button size="sm" onClick={() => void sync(provider)}>
                  <Icon name="refresh" />
                  同步模型列表
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    await setProviderEnabled(provider.id, !provider.enabled);
                    pushToast(provider.enabled ? "已停用该配置；引用它的会话会提示配置不可用" : "已启用该配置");
                  }}
                >
                  <Icon name={provider.enabled ? "stop" : "play"} />
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
            </section>
          );
        })}
      </CardGrid>

      <Card>
        <h3 className="text-[13px] font-[650] text-ink">切换只影响当前会话</h3>
        <p className="page-intro mt-2 mb-0 max-w-none text-[12px] text-[#8a8c92]">
          保留对话历史与工具结果。执行中切换会等待当前回合结束；累计 Token 仍按实际调用的 Provider 记录。新会话在任务里新建后选择模型。
        </p>
      </Card>

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
